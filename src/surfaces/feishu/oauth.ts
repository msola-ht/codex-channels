import type { Logger } from "pino";

import type { FeishuOutbox } from "./outbox.js";
import {
  renderFeishuOAuthCard,
  renderFeishuOAuthOutcomeCard,
} from "./oauth-card.js";
import type {
  FeishuOAuthApi,
} from "./oauth-device-flow.js";
import {
  feishuTokenStatus,
  type FeishuUserTokenStore,
} from "./oauth-token-store.js";

const maximumScopesPerAuthorization = 100;
const defaultCloseTimeoutMs = 5_000;

export type FeishuUserAuthorizationStatus =
  | "pending"
  | "missing"
  | "valid"
  | "refreshable"
  | "expired";

export interface FeishuOAuthControllerPort {
  beginAuthorization(chatId: string, userOpenId: string): "started" | "running";
  status(userOpenId: string): Promise<FeishuUserAuthorizationStatus>;
  revoke(userOpenId: string): Promise<boolean>;
}

export class FeishuOAuthController implements FeishuOAuthControllerPort {
  private readonly pending = new Map<string, {
    controller: AbortController;
    task: Promise<void>;
  }>();
  private closed = false;

  constructor(
    private readonly appId: string,
    private readonly api: FeishuOAuthApi,
    private readonly tokens: FeishuUserTokenStore,
    private readonly outbox: Pick<
      FeishuOutbox,
      "deliverCard" | "deliverText" | "updateCard"
    >,
    private readonly logger: Logger,
    private readonly closeTimeoutMs = defaultCloseTimeoutMs,
  ) {}

  beginAuthorization(
    chatId: string,
    userOpenId: string,
  ): "started" | "running" {
    const key = this.key(userOpenId);
    if (this.pending.has(key)) {
      return "running";
    }
    if (this.closed) {
      return "running";
    }
    const controller = new AbortController();
    const task = this.runAuthorization(
      chatId,
      userOpenId,
      controller.signal,
    ).catch(async (error) => {
      if (controller.signal.aborted) {
        return;
      }
      this.logger.warn(
        {
          surface: "feishu",
          accountId: this.appId,
          errorType: safeErrorType(error),
        },
        "飞书用户授权流程失败",
      );
      try {
        await this.outbox.deliverText(
          chatId,
          "飞书授权处理失败，请确认应用已开通 application:application:self_manage 后重试；凭据未保存。",
        );
      } catch {
        this.logger.warn(
          {
            surface: "feishu",
            accountId: this.appId,
          },
          "飞书授权失败提示未送达",
        );
      }
    }).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, { controller, task });
    return "started";
  }

  async status(
    userOpenId: string,
  ): Promise<FeishuUserAuthorizationStatus> {
    if (this.pending.has(this.key(userOpenId))) {
      return "pending";
    }
    return feishuTokenStatus(
      await this.tokens.get(this.appId, userOpenId),
    );
  }

  async revoke(userOpenId: string): Promise<boolean> {
    const pending = this.pending.get(this.key(userOpenId));
    pending?.controller.abort();
    if (pending) {
      await pending.task;
    }
    const existing = await this.tokens.get(this.appId, userOpenId);
    await this.tokens.remove(this.appId, userOpenId);
    return existing !== null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      entry.controller.abort();
    }
    if (entries.length === 0) {
      return;
    }
    await this.waitForClose(entries.map((entry) => entry.task));
  }

  private async runAuthorization(
    chatId: string,
    userOpenId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const appScopes = await this.api.listGrantedUserScopes(signal);
    if (signal.aborted) {
      return;
    }
    if (appScopes.length === 0) {
      await this.outbox.deliverText(
        chatId,
        "当前飞书应用没有可授权的用户级权限，请先配置应用 Scope。",
      );
      return;
    }
    if (appScopes.length > maximumScopesPerAuthorization) {
      await this.outbox.deliverText(
        chatId,
        `当前应用包含 ${appScopes.length} 项用户权限，超过单次授权上限；暂未发起授权。`,
      );
      return;
    }
    const existingToken = await this.tokens.get(this.appId, userOpenId);
    if (signal.aborted) {
      return;
    }
    const scopes = feishuTokenStatus(existingToken) === "valid"
      ? appScopes.filter((scope) => !existingToken!.scopes.includes(scope))
      : appScopes;
    if (scopes.length === 0) {
      await this.outbox.deliverText(
        chatId,
        "当前飞书账号已授权，现有权限已覆盖应用当前开放的用户权限，无需重复授权。",
      );
      return;
    }
    const authorization = await this.api.requestDeviceAuthorization(
      scopes,
      signal,
    );
    if (signal.aborted) {
      return;
    }
    const messageId = await this.outbox.deliverCard(
      chatId,
      renderFeishuOAuthCard(
        authorization.verificationUriComplete,
        authorization.scopes,
        authorization.expiresInSeconds,
      ),
    );
    const result = await this.api.pollDeviceToken(authorization, signal);
    if (signal.aborted) {
      return;
    }
    if (result.status !== "authorized") {
      await this.outbox.updateCard(
        chatId,
        messageId,
        renderFeishuOAuthOutcomeCard(result.status),
      );
      return;
    }
    const authorizedOpenId = await this.api.readAuthorizedUser(
      result.token.accessToken,
      signal,
    );
    if (authorizedOpenId !== userOpenId) {
      await this.outbox.updateCard(
        chatId,
        messageId,
        renderFeishuOAuthOutcomeCard("identity-mismatch"),
      );
      return;
    }
    const previousToken = await this.tokens.get(this.appId, userOpenId);
    if (signal.aborted) {
      return;
    }
    const now = Date.now();
    const nextToken = {
      appId: this.appId,
      userOpenId,
      accessToken: result.token.accessToken,
      refreshToken: result.token.refreshToken,
      expiresAt: now + result.token.expiresInSeconds * 1_000,
      refreshExpiresAt:
        now + result.token.refreshExpiresInSeconds * 1_000,
      scopes: result.token.scopes,
      grantedAt: now,
    };
    try {
      await this.tokens.set(nextToken);
    } catch (error) {
      await this.restoreToken(userOpenId, previousToken);
      throw error;
    }
    if (signal.aborted) {
      await this.restoreToken(userOpenId, previousToken);
      return;
    }
    try {
      await this.outbox.updateCard(
        chatId,
        messageId,
        renderFeishuOAuthOutcomeCard("success"),
      );
    } catch {
      this.logger.warn(
        {
          surface: "feishu",
          accountId: this.appId,
        },
        "飞书授权成功卡片更新失败",
      );
      try {
        await this.outbox.deliverText(
          chatId,
          "飞书授权成功，凭据已安全保存，但结果卡片更新失败。",
        );
      } catch {
        this.logger.warn(
          {
            surface: "feishu",
            accountId: this.appId,
          },
          "飞书授权成功提示未送达",
        );
      }
    }
  }

  private key(userOpenId: string): string {
    return `${this.appId}:${userOpenId}`;
  }

  private async waitForClose(tasks: readonly Promise<void>[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const completed = Promise.allSettled(tasks).then(() => "completed" as const);
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), this.closeTimeoutMs);
    });
    const result = await Promise.race([completed, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
    if (result === "timed-out") {
      this.logger.warn(
        {
          surface: "feishu",
          accountId: this.appId,
          pendingCount: tasks.length,
        },
        "飞书用户授权关闭等待超时",
      );
    }
  }

  private async restoreToken(
    userOpenId: string,
    previousToken: Awaited<ReturnType<FeishuUserTokenStore["get"]>>,
  ): Promise<void> {
    try {
      if (previousToken) {
        await this.tokens.set(previousToken);
      } else {
        await this.tokens.remove(this.appId, userOpenId);
      }
    } catch {
      this.logger.warn(
        {
          surface: "feishu",
          accountId: this.appId,
        },
        "飞书用户授权取消后的凭据回滚失败",
      );
    }
  }
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && error.name
    ? error.name.slice(0, 80)
    : "unknown";
}
