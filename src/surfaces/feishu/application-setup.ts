import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import type { ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import type { FeishuCardDocument } from "./approval-card.js";
import {
  feishuFloatingMenuDisplayStrategy,
  FeishuApplicationSetupError,
  requiredFeishuApplicationTenantScopes,
  type FeishuApplicationApi,
  type FeishuApplicationSnapshot,
  type FeishuApplicationTenantScope,
} from "./application-api.js";
import type { FeishuCardAction } from "./card-action.js";
import { feishuCommandMenuEventKey } from "./command-center.js";
import { toFeishuInAppUrl } from "./oauth-card.js";
import type { FeishuOutbox } from "./outbox.js";
import type { FeishuPermissionRuntimeStatus } from "./permissions.js";

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
  missingTenantScopes: readonly FeishuApplicationTenantScope[];
  runtime: FeishuPermissionRuntimeStatus;
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
    const missingTenantScopes = missingRequiredTenantScopes(snapshot);
    const configurationNeeded = snapshot !== undefined
      && !snapshot.hasPendingVersion
      && !applicationConfigurationComplete(snapshot, runtime);
    const actionAvailable =
      missingTenantScopes.length > 0 || configurationNeeded;
    const token = randomBytes(18).toString("base64url");
    const messageId = await this.outbox.deliverCard(
      target.conversationId,
      renderDoctorCard(
        this.appId,
        runtime,
        snapshot,
        actionAvailable ? token : undefined,
      ),
    );
    if (
      this.closed
      || !actionAvailable
    ) {
      return;
    }
    this.prune();
    this.pending.set(token, {
      target,
      actorId,
      messageId,
      missingTenantScopes,
      runtime,
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
      || command !== "authorize"
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
        "当前已有进行中的飞书应用授权任务。",
      ).catch(() => {});
      return "accepted";
    }
    this.active = true;
    const task = this.authorize(pending).finally(() => {
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

  private async authorize(pending: PendingSetup): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    let authorizationMessageId: string | undefined;
    let authorizationDeliveryFailed = false;
    try {
      await this.outbox.updateCard(
        pending.target.conversationId,
        pending.messageId,
        renderSetupProgressCard(
          pending.missingTenantScopes.length > 0
            ? "正在通过飞书官方流程授权当前应用…"
            : "正在自动配置当前飞书应用…",
        ),
      );
      if (pending.missingTenantScopes.length > 0) {
        let delivery: Promise<string> | undefined;
        await this.api.authorizeApplication(
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
          pending.missingTenantScopes,
        );
        authorizationMessageId = await delivery;
        if (!authorizationMessageId) {
          throw new Error("飞书应用授权卡片未发送");
        }
      }
      const snapshot = await this.api.inspect(controller.signal);
      if (applicationConfigurationComplete(snapshot, pending.runtime)) {
        await this.outbox.updateCard(
          pending.target.conversationId,
          pending.messageId,
          renderSetupOutcomeCard(
            true,
            "官方授权已完成，当前应用配置检测也已通过。",
          ),
        );
        if (authorizationMessageId) {
          await this.updateAuthorizationOutcome(
            pending,
            authorizationMessageId,
          );
        }
        return;
      }
      await this.api.configureApplication(controller.signal);
      const configured = await this.api.inspect(controller.signal);
      const outcome = configured.hasPendingVersion
        ? "菜单、事件与回调已自动配置并提交发布，正在等待管理员审核。"
        : applicationConfigurationComplete(configured, pending.runtime)
          ? "菜单、事件与回调已自动配置并发布完成。"
          : "菜单、事件与回调已自动配置并提交发布，请稍后发送 /feishu doctor 复查。";
      await this.outbox.updateCard(
        pending.target.conversationId,
        pending.messageId,
        renderSetupOutcomeCard(
          true,
          outcome,
        ),
      );
      if (authorizationMessageId) {
        await this.updateAuthorizationOutcome(
          pending,
          authorizationMessageId,
        );
      }
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
        renderSetupOutcomeCard(true, "飞书官方授权已完成。"),
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
        errorCode: error instanceof FeishuApplicationSetupError
          ? error.code
          : undefined,
        authorizationFailure:
          error instanceof FeishuApplicationSetupError
            ? error.authorizationFailure
            : undefined,
        authorizationDiagnostic:
          error instanceof FeishuApplicationSetupError
            ? error.authorizationDiagnostic
            : undefined,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "飞书应用授权失败",
    );
  }
}

export function renderDoctorCard(
  appId: string,
  runtime: FeishuPermissionRuntimeStatus,
  snapshot?: FeishuApplicationSnapshot,
  setupToken?: string,
): FeishuCardDocument {
  const missingScopes = missingRequiredTenantScopes(snapshot);
  const elements: Array<Record<string, unknown>> = [{
    tag: "markdown",
    content: renderDoctorSummary(runtime, snapshot),
  }];
  const actions = renderDoctorActions(appId, runtime, snapshot, missingScopes);
  if (actions) {
    elements.push({
      tag: "markdown",
      content: actions,
    });
  }
  if (setupToken) {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
          text: {
            tag: "plain_text",
            content: missingScopes.length > 0
              ? snapshot ? "授权并自动配置" : "授权并重新检测"
              : "自动配置",
        },
        type: "primary",
        value: {
          codexc_feishu_setup_token: setupToken,
          codexc_feishu_setup_action: "authorize",
        },
      }],
    });
  }
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: doctorNeedsAttention(runtime, snapshot, missingScopes)
        ? "blue"
        : "green",
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
        content: "授权飞书应用",
      },
    },
    elements: [
      {
        tag: "markdown",
        content: [
          "请通过飞书官方流程确认当前应用授权。",
          "",
          "授权完成后，Gateway 会启用 Codex 菜单、追加长连接菜单事件与卡片回调并提交应用版本。",
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
      || parsed.origin === "https://open.feishu.cn"
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
        content: "飞书应用授权",
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
        content: success ? "飞书配置完成" : "飞书配置未完成",
      },
    },
    elements: [{
      tag: "markdown",
      content: text,
    }],
  };
}

function renderDoctorSummary(
  runtime: FeishuPermissionRuntimeStatus,
  snapshot: FeishuApplicationSnapshot | undefined,
): string {
  return [
    runtime.connectionReady ? "✅ 长连接" : "❌ 长连接：未就绪",
    "✅ 消息接收",
    renderCardActionStatus(runtime, snapshot),
    renderMenuStatus(runtime, snapshot),
  ].join("\n");
}

function renderCardActionStatus(
  runtime: FeishuPermissionRuntimeStatus,
  snapshot: FeishuApplicationSnapshot | undefined,
): string {
  if (runtime.cardActionObserved) {
    return "✅ 卡片交互";
  }
  return snapshot?.cardCallbackConfigured
    ? "◯ 卡片交互：已配置，待使用验证"
    : "⚠️ 卡片交互：回调待确认";
}

function renderMenuStatus(
  runtime: FeishuPermissionRuntimeStatus,
  snapshot: FeishuApplicationSnapshot | undefined,
): string {
  if (runtime.menuEventObserved) {
    return "✅ 自定义菜单";
  }
  if (snapshot?.menuConfigured && snapshot.menuEventConfigured) {
    return "◯ 自定义菜单：已配置，待点击验证";
  }
  if (snapshot?.menuConfigured) {
    return "⚠️ 自定义菜单：已启用，事件待确认";
  }
  if (snapshot && hasCodexcMenu(snapshot)) {
    return "⚠️ 自定义菜单：已添加，尚未启用";
  }
  return snapshot
    ? "⚠️ 自定义菜单：尚未添加"
    : "◯ 自定义菜单：配置状态暂不可读";
}

function hasCodexcMenu(snapshot: FeishuApplicationSnapshot): boolean {
  return snapshot.botMenus.some(
    (menu) =>
      menu.event_key === feishuCommandMenuEventKey
      && menu.menu_content_type === 2,
  );
}

function missingRequiredTenantScopes(
  snapshot: FeishuApplicationSnapshot | undefined,
): FeishuApplicationTenantScope[] {
  if (!snapshot) {
    return [...requiredFeishuApplicationTenantScopes];
  }
  const granted = new Set(snapshot.grantedTenantScopes);
  return requiredFeishuApplicationTenantScopes.filter(
    (scope) => !granted.has(scope),
  );
}

function applicationConfigurationComplete(
  snapshot: FeishuApplicationSnapshot,
  runtime: FeishuPermissionRuntimeStatus,
): boolean {
  return missingRequiredTenantScopes(snapshot).length === 0
    && (runtime.cardActionObserved || snapshot.cardCallbackConfigured)
    && (
      runtime.menuEventObserved
      || (snapshot.menuEventConfigured && snapshot.menuConfigured)
    )
    && snapshot.botMenuDisplayStrategy === feishuFloatingMenuDisplayStrategy
    && !snapshot.hasPendingVersion;
}

function renderDoctorActions(
  appId: string,
  runtime: FeishuPermissionRuntimeStatus,
  snapshot: FeishuApplicationSnapshot | undefined,
  missingScopes: readonly string[],
): string | undefined {
  const lines: string[] = [];
  if (missingScopes.length > 0) {
    lines.push(`需要开通 ${missingScopes.length} 项应用权限。`);
  }
  if (!runtime.connectionReady) {
    lines.push("请先检查 Gateway 日志和飞书长连接配置。");
  }
  if (
    snapshot
    && (
      (!runtime.cardActionObserved && !snapshot.cardCallbackConfigured)
      || (
        !runtime.menuEventObserved
        && (!snapshot.menuEventConfigured || !snapshot.menuConfigured)
      )
      || snapshot.hasPendingVersion
    )
  ) {
    if (snapshot.hasPendingVersion) {
      const inAppUrl = toFeishuInAppUrl(
        `https://open.feishu.cn/app/${appId}`,
      );
      lines.push(
        `开放平台存在待发布版本，请[在飞书内处理当前应用](${inAppUrl})。`,
      );
    } else {
      lines.push("可点击下方按钮自动补齐应用配置并提交版本。");
    }
  }
  return lines.length > 0 ? lines.join("\n\n") : undefined;
}

function doctorNeedsAttention(
  runtime: FeishuPermissionRuntimeStatus,
  snapshot: FeishuApplicationSnapshot | undefined,
  missingScopes: readonly string[],
): boolean {
  return !runtime.connectionReady
    || snapshot === undefined
    || missingScopes.length > 0
    || (!runtime.cardActionObserved && !snapshot.cardCallbackConfigured)
    || (
      !runtime.menuEventObserved
      && (!snapshot.menuEventConfigured || !snapshot.menuConfigured)
    )
    || snapshot.hasPendingVersion;
}

function setupFailureText(error: unknown): string {
  const code = (error as Partial<FeishuApplicationSetupError>).code;
  if (code === "configuration-conflict") {
    return "当前应用已有待发布版本，未自动覆盖。请先在飞书开放平台处理该版本。";
  }
  if (code === "configuration-failed") {
    return "飞书自动配置或发布失败，未继续重试。请发送 /feishu doctor 复查。";
  }
  if (code === "authorization-invalid") {
    const failure = (error as Partial<FeishuApplicationSetupError>)
      .authorizationFailure;
    if (failure === "access-denied") {
      return "飞书授权页未完成确认或已拒绝，请重新发送 /feishu doctor。";
    }
    if (failure === "expired") {
      return "飞书应用授权已过期，请重新发送 /feishu doctor。";
    }
    if (failure === "app-mismatch") {
      return "飞书授权结果不是当前应用，已安全拒绝。请重新发送 /feishu doctor。";
    }
    if (failure === "unsupported-tenant") {
      return "当前项目暂不支持 Lark 租户。";
    }
    return "应用授权未完成或已失效，请重新发送 /feishu doctor。";
  }
  return "授权未完成。Gateway 已隐藏上游错误详情，请发送 /feishu doctor 复查。";
}
