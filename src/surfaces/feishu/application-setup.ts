import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import type { ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import type { FeishuCardDocument } from "./approval-card.js";
import type {
  FeishuApplicationApi,
  FeishuApplicationSnapshot,
  FeishuApplicationSetupError,
} from "./application-api.js";
import type { FeishuCardAction } from "./card-action.js";
import { toFeishuInAppUrl } from "./oauth-card.js";
import type { FeishuOutbox } from "./outbox.js";
import {
  renderFeishuDoctor,
  type FeishuPermissionRuntimeStatus,
  type FeishuUserAuthorizationStatus,
} from "./permissions.js";

const defaultTokenTtlMs = 10 * 60_000;
const defaultCloseTimeoutMs = 5_000;
const maximumPendingCards = 100;

export type FeishuApplicationSetupActionResult =
  | "accepted"
  | "ignored"
  | "invalid";

interface PendingSetup {
  target: ConversationTarget;
  actorId: string;
  messageId: string;
  expiresAt: number;
}

interface FeishuApplicationSetupOptions {
  tokenTtlMs?: number;
  closeTimeoutMs?: number;
  now?: () => number;
}

export class FeishuApplicationSetupController {
  private readonly pending = new Map<string, PendingSetup>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly tokenTtlMs: number;
  private readonly closeTimeoutMs: number;
  private readonly now: () => number;
  private activeController: AbortController | undefined;
  private active = false;
  private closed = false;

  constructor(
    private readonly appId: string,
    private readonly api: FeishuApplicationApi,
    private readonly outbox: Pick<
      FeishuOutbox,
      "deliverCard" | "deliverText" | "updateCard"
    >,
    private readonly access: SurfaceAccessPolicy,
    private readonly logger: Logger,
    options: FeishuApplicationSetupOptions = {},
  ) {
    this.tokenTtlMs = options.tokenTtlMs ?? defaultTokenTtlMs;
    this.closeTimeoutMs = options.closeTimeoutMs ?? defaultCloseTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  async openDoctor(
    target: ConversationTarget,
    actorId: string,
    runtime: FeishuPermissionRuntimeStatus,
    userAuthorization: FeishuUserAuthorizationStatus,
  ): Promise<void> {
    if (
      this.closed
      || !this.access.isAllowed({ target, actorId })
    ) {
      return;
    }
    let snapshot: FeishuApplicationSnapshot | undefined;
    try {
      snapshot = await this.api.inspect();
    } catch (error) {
      this.logFailure(target, "inspect", error);
    }
    const token = randomBytes(18).toString("base64url");
    const messageId = await this.outbox.deliverCard(
      target.conversationId,
      renderDoctorCard(
        this.appId,
        runtime,
        userAuthorization,
        snapshot,
        snapshot?.hasPendingVersion || isComplete(snapshot)
          ? undefined
          : token,
      ),
    );
    if (
      this.closed
      || snapshot?.hasPendingVersion
      || isComplete(snapshot)
    ) {
      return;
    }
    this.prune();
    this.pending.set(token, {
      target,
      actorId,
      messageId,
      expiresAt: this.now() + this.tokenTtlMs,
    });
    while (this.pending.size > maximumPendingCards) {
      const first = this.pending.keys().next();
      if (first.done) {
        break;
      }
      this.pending.delete(first.value);
    }
  }

  handleCardAction(
    action: FeishuCardAction,
  ): FeishuApplicationSetupActionResult {
    const token = action.value.codexc_feishu_setup_token;
    const command = action.value.codexc_feishu_setup_action;
    if (token === undefined && command === undefined) {
      return "ignored";
    }
    if (
      this.closed
      || action.tag !== "button"
      || token === undefined
      || command !== "configure"
    ) {
      return "invalid";
    }
    this.prune();
    const pending = this.pending.get(token);
    if (
      !pending
      || pending.messageId !== action.messageId
      || pending.target.conversationId !== action.chatId
      || pending.actorId !== action.actorOpenId
      || !this.access.isAllowed({
        target: pending.target,
        actorId: action.actorOpenId,
      })
    ) {
      return "invalid";
    }
    this.pending.delete(token);
    if (this.active) {
      void this.outbox.deliverText(
        pending.target.conversationId,
        "当前已有进行中的飞书应用配置任务。",
      ).catch(() => {});
      return "accepted";
    }
    this.active = true;
    const task = this.configure(pending).finally(() => {
      this.active = false;
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return "accepted";
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending.clear();
    this.activeController?.abort();
    if (this.tasks.size === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const completed = Promise.allSettled([...this.tasks]);
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeTimeoutMs);
    });
    await Promise.race([completed, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  private async configure(pending: PendingSetup): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    let authorizationMessageId: string | undefined;
    let authorizationDeliveryFailed = false;
    try {
      await this.outbox.updateCard(
        pending.target.conversationId,
        pending.messageId,
        renderSetupProgressCard("正在检查并配置飞书应用…"),
      );
      let delivery: Promise<string> | undefined;
      await this.api.authorizeConfiguration(
        controller.signal,
        (url, expiresInSeconds) => {
          delivery = this.outbox.deliverCard(
            pending.target.conversationId,
            renderConfigurationAuthorizationCard(
              url,
              expiresInSeconds,
            ),
          );
          void delivery.catch(() => {
            authorizationDeliveryFailed = true;
            controller.abort();
          });
        },
      );
      authorizationMessageId = await delivery;
      if (!authorizationMessageId) {
        throw new Error("飞书应用配置授权卡片未发送");
      }
      const snapshot = await this.api.inspect(controller.signal);
      if (isComplete(snapshot)) {
        await this.outbox.updateCard(
          pending.target.conversationId,
          pending.messageId,
          renderSetupOutcomeCard(
            true,
            "应用配置已经完整，无需提交新版本。",
          ),
        );
        await this.updateAuthorizationOutcome(
          pending,
          authorizationMessageId,
        );
        return;
      }
      const result = await this.api.configureAndPublish(
        snapshot,
        controller.signal,
      );
      await this.outbox.updateCard(
        pending.target.conversationId,
        pending.messageId,
        renderSetupOutcomeCard(
          true,
          result.version
            ? `已提交版本 ${result.version}；如企业启用了应用审核，请由管理员通过后生效。`
            : "已提交新版本；如企业启用了应用审核，请由管理员通过后生效。",
        ),
      );
      await this.updateAuthorizationOutcome(
        pending,
        authorizationMessageId,
      );
    } catch (error) {
      if (controller.signal.aborted && !authorizationDeliveryFailed) {
        return;
      }
      this.logFailure(pending.target, "configure", error);
      try {
        await this.outbox.updateCard(
          pending.target.conversationId,
          pending.messageId,
          renderSetupOutcomeCard(
            false,
            setupFailureText(error),
          ),
        );
      } catch {
        this.logFailure(pending.target, "outcome", error);
      }
    } finally {
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [token, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(token);
      }
    }
  }

  private async updateAuthorizationOutcome(
    pending: PendingSetup,
    messageId: string,
  ): Promise<void> {
    try {
      await this.outbox.updateCard(
        pending.target.conversationId,
        messageId,
        renderSetupOutcomeCard(true, "应用配置授权已完成。"),
      );
    } catch (error) {
      this.logFailure(pending.target, "authorization-outcome", error);
    }
  }

  private logFailure(
    target: ConversationTarget,
    phase: string,
    error: unknown,
  ): void {
    this.logger.warn(
      {
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
        phase,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "飞书应用一键配置失败",
    );
  }
}

export function renderDoctorCard(
  appId: string,
  runtime: FeishuPermissionRuntimeStatus,
  userAuthorization: FeishuUserAuthorizationStatus,
  snapshot?: FeishuApplicationSnapshot,
  setupToken?: string,
): FeishuCardDocument {
  const details = renderFeishuDoctor(
    appId,
    runtime,
    userAuthorization,
  );
  const elements: Array<Record<string, unknown>> = [{
    tag: "markdown",
    content: details,
  }];
  if (snapshot) {
    elements.push({
      tag: "markdown",
      content: [
        "**应用配置检测**",
        `- 应用管理权限：${snapshot.hasPatchScope ? "已开通" : "待授权"}`,
        `- 消息事件：${snapshot.messageEventConfigured ? "已配置" : "待配置"}`,
        `- 菜单事件：${snapshot.menuEventConfigured ? "已配置" : "待配置"}`,
        `- 卡片回调：${snapshot.cardCallbackConfigured ? "已配置" : "待配置"}`,
        `- Codex 菜单：${snapshot.menuConfigured ? "已发布" : "待配置"}`,
        `- 待处理版本：${snapshot.hasPendingVersion ? "存在" : "无"}`,
      ].join("\n"),
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "暂时无法读取应用配置。点击一键配置后，Gateway 会先通过飞书官方授权确认管理身份，再重新检测并只补齐缺项。",
    });
  }
  if (setupToken) {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: "确认并一键配置",
        },
        type: "primary",
        value: {
          codexc_feishu_setup_token: setupToken,
          codexc_feishu_setup_action: "configure",
        },
      }],
    });
  } else if (snapshot?.hasPendingVersion) {
    elements.push({
      tag: "markdown",
      content: "检测到已有未完成版本。为避免发布无关改动，Gateway 不会自动继续；请先在开放平台处理该版本。",
    });
  }
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: isComplete(snapshot) ? "green" : "blue",
      title: {
        tag: "plain_text",
        content: "飞书 Doctor",
      },
    },
    elements,
  };
}

function renderConfigurationAuthorizationCard(
  url: string,
  expiresInSeconds: number,
): FeishuCardDocument {
  const inAppUrl = toConfigurationInAppUrl(url);
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "授权飞书应用配置",
      },
    },
    elements: [
      {
        tag: "markdown",
        content: [
          "请确认允许 Gateway 增量配置当前应用。",
          "",
          "仅添加缺少的应用管理权限、消息事件、机器人菜单事件和卡片回调；不会删除已有配置。",
          `链接约 ${Math.max(1, Math.ceil(expiresInSeconds / 60))} 分钟后失效。`,
        ].join("\n"),
      },
      {
        tag: "action",
        actions: [{
          tag: "button",
          text: {
            tag: "plain_text",
            content: "在飞书内确认",
          },
          type: "primary",
          multi_url: {
            url: inAppUrl,
            pc_url: inAppUrl,
            android_url: inAppUrl,
            ios_url: inAppUrl,
          },
        }],
      },
    ],
  };
}

function toConfigurationInAppUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.origin === "https://accounts.feishu.cn"
    ? toFeishuInAppUrl(url)
    : parsed.toString();
}

function renderSetupProgressCard(text: string): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "飞书应用配置",
      },
    },
    elements: [{
      tag: "markdown",
      content: text,
    }],
  };
}

function renderSetupOutcomeCard(
  success: boolean,
  text: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: success ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: success ? "飞书应用配置完成" : "飞书应用配置未完成",
      },
    },
    elements: [{
      tag: "markdown",
      content: text,
    }],
  };
}

function isComplete(
  snapshot: FeishuApplicationSnapshot | undefined,
): boolean {
  return snapshot !== undefined
    && snapshot.hasPatchScope
    && snapshot.messageEventConfigured
    && snapshot.menuEventConfigured
    && snapshot.cardCallbackConfigured
    && snapshot.menuConfigured
    && !snapshot.hasPendingVersion;
}

function setupFailureText(error: unknown): string {
  const code = (error as Partial<FeishuApplicationSetupError>).code;
  if (code === "pending-version") {
    return "检测到已有未完成版本。为避免发布无关改动，请先在开放平台处理该版本后重试。";
  }
  if (code === "authorization-invalid") {
    return "应用配置授权未完成或已失效，请重新发送 /feishu doctor。";
  }
  if (code === "publish-failed") {
    return "菜单与订阅可能已写入，但版本提交失败。请发送 /feishu doctor 复查后再决定是否重试。";
  }
  if (code === "configure-failed") {
    return "部分应用配置可能已写入，但配置未全部完成。请发送 /feishu doctor 复查后再决定是否重试。";
  }
  return "配置未完成。Gateway 已隐藏上游错误详情，请发送 /feishu doctor 复查。";
}
