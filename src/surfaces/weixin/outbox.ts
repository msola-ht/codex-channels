import type { Logger } from "pino";
import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";

import type {
  ConversationTarget,
  OutputEvent,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { resolveSurfaceDelivery } from "../delivery-policy.js";
import { exponentialRetryDelay, withDeliveryRetry } from "../delivery-retry.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import type { SurfaceOutputPort } from "../types.js";
import {
  createTurnStartedPresentation,
  renderPlainLifecyclePresentation,
} from "../lifecycle-presentation.js";
import {
  contentTruncatedText,
  emptyCodexResponseText,
  formatCodexWarning,
  formatConversationIdleReleased,
  visibleUpstreamMessage,
} from "../output-copy.js";

import { validateWeixinAccountId } from "./credential-store.js";
import {
  maximumWeixinOutboundFileBytes,
  WeixinProtocolError,
  type WeixinFileSendProtocolClient,
  type WeixinImageSendProtocolClient,
  type WeixinProtocolClient,
} from "./protocol-client.js";
import {
  readWeixinOutboundImage,
  WeixinOutboundImageError,
} from "./outbound-image.js";
import {
  WeixinReplyContextStore,
  type WeixinReplyContext,
} from "./reply-context-store.js";
import {
  formatWeixinCommandText,
  renderWeixinTurnCompleted,
} from "./command-renderer.js";
import { formatWeixinFinalText } from "./final-text-format.js";
import type { WeixinTypingController } from "./typing-controller.js";

const maximumChunkCharacters = 4_000;
const maximumChunks = 5;
const truncationNotice = `\n\n[${contentTruncatedText}]`;
const previewNotice = "\n\n[内容预览]";
const fileFailureNotice = "[文件发送失败，已改为分段文本]\n\n";
const finalAnswerFileName = "codex-final-answer.txt";

export type WeixinOutboxErrorCode =
  | "image-sender-unavailable"
  | "missing-reply-context"
  | "unauthorized-recipient";

export class WeixinOutboxError extends Error {
  constructor(readonly code: WeixinOutboxErrorCode) {
    super("微信消息无法发送");
    this.name = "WeixinOutboxError";
  }
}

export interface WeixinOutboxOptions {
  capacity?: number;
  closeTimeoutMs?: number;
  autoCompactPercent?: (
    provider: string | null | undefined,
    model: string | null | undefined,
  ) => number | null;
  debugEnabled?: boolean;
  onReplyContextInvalidated?: (
    target: ConversationTarget,
    expectedContextToken?: string,
  ) => Promise<void>;
  imageClient?: Pick<WeixinImageSendProtocolClient, "sendImage">;
  fileClient?: Pick<WeixinFileSendProtocolClient, "sendFile">;
  readImage?: typeof readWeixinOutboundImage;
  typing?: Pick<WeixinTypingController, "close" | "stop">;
}

export class WeixinOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly accountId: string;
  private readonly client: Pick<WeixinProtocolClient, "sendText">;
  private closed = false;

  constructor(
    accountId: string,
    client: Pick<WeixinProtocolClient, "sendText">,
    private readonly contexts: WeixinReplyContextStore,
    private readonly access: SurfaceAccessPolicy,
    logger: Logger,
    private readonly options: WeixinOutboxOptions = {},
  ) {
    this.accountId = validateWeixinAccountId(accountId);
    this.client = {
      sendText: (input, signal) => withDeliveryRetry(
        {
          component: "Weixin",
          maximumAttempts: 3,
          maximumDelayMs: 5_000,
          delayMs: weixinSendRetryDelay,
          logger,
          metadata: weixinOutputErrorMetadata,
        },
        () => (signal === undefined
          ? client.sendText(input)
          : client.sendText(input, signal)),
        signal,
      ),
    };
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Weixin",
      ...(options.capacity === undefined
        ? {}
        : { capacity: options.capacity }),
      ...(options.closeTimeoutMs === undefined
        ? {}
        : { closeTimeoutMs: options.closeTimeoutMs }),
      errorMetadata: weixinOutputErrorMetadata,
    });
  }

  handle(event: OutputEvent): void {
    if (
      this.closed
      || event.target.surface !== "weixin"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    // 渠道投递策略只在这里判定一次：微信的单次回复窗口只保留生命周期、终态与全局空闲
    // 通知，推理、计划、操作、连接等事件不占用该预算（详见 delivery-policy.ts）。
    const decision = resolveSurfaceDelivery("weixin", event);
    if (decision.disposition === "ignore") {
      return;
    }
    if (event.type === "turn.started") {
      this.enqueueText(
        event.target,
        renderPlainLifecyclePresentation(
          createTurnStartedPresentation(
            event.background ? event.threadId : undefined,
            event.identity,
          ),
        ),
        true,
      );
      return;
    }
    const rendered = this.render(event);
    if (rendered === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      (signal) => this.sendEvent(
        event,
        rendered,
        signal,
        this.contexts.get(event.target),
      ),
      decision.critical,
    );
  }

  notifyText(target: ConversationTarget, text: string): boolean {
    if (this.closed || !this.matches(target)) {
      return false;
    }
    return this.enqueueText(target, text, true);
  }

  deliverText(target: ConversationTarget, text: string): Promise<void> {
    if (this.closed || !this.matches(target)) {
      return Promise.reject(new Error("微信输出目标无效或队列已关闭"));
    }
    return this.delivery.runOrdered(
      target.conversationId,
      (signal) => this.send(
        target,
        text,
        maximumChunks,
        signal,
        this.contexts.get(target),
      ),
    );
  }

  deliverTextSequence(
    target: ConversationTarget,
    texts: readonly string[],
    requestSignal?: AbortSignal,
  ): Promise<void> {
    if (this.closed || !this.matches(target)) {
      return Promise.reject(new Error("微信输出目标无效或队列已关闭"));
    }
    return this.delivery.runOrdered(
      target.conversationId,
      async (signal) => {
        for (const text of texts) {
          signal.throwIfAborted();
          await this.send(
            target,
            text,
            maximumChunks,
            signal,
            this.contexts.get(target),
          );
        }
      },
      requestSignal,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.delivery.close();
      return;
    }
    this.closed = true;
    await this.options.typing?.close();
    await this.delivery.close();
    this.contexts.clear();
  }

  private render(event: OutputEvent): string | null {
    switch (event.type) {
      case "text.completed":
        if (event.phase !== "final_answer") {
          return null;
        }
        return event.text.trim().length === 0
          ? emptyCodexResponseText
          : formatWeixinFinalText(
              `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`,
            );
      case "turn.completed": {
        return formatWeixinCommandText(
          renderWeixinTurnCompleted(
            event,
            this.options.debugEnabled ?? false,
            this.options.autoCompactPercent,
          ),
          { structuredFields: true },
        );
      }
      case "warning":
        return formatCodexWarning(visibleUpstreamMessage(event.message));
      case "conversation.idle.released":
        return formatWeixinCommandText(
          formatConversationIdleReleased(event.minutes, event.threadId),
          { structuredFields: true },
        );
      default:
        return null;
    }
  }

  private async sendEvent(
    event: OutputEvent,
    text: string,
    signal: AbortSignal | undefined,
    context: WeixinReplyContext | undefined,
  ): Promise<void> {
    signal = this.closed ? undefined : signal;
    if (
      event.type === "turn.completed"
      || (
        event.type === "text.completed"
        && event.phase === "final_answer"
      )
    ) {
      await this.options.typing?.stop(event.target);
    }
    if (
      event.type === "text.completed"
      && event.phase === "final_answer"
      && text.length > maximumChunkCharacters * maximumChunks
      && await this.sendLongFinalAnswer(event.target, text, signal, context)
    ) {
      return;
    }
    await this.send(event.target, text, maximumChunks, signal, context);
  }

  private async sendLongFinalAnswer(
    target: ConversationTarget,
    text: string,
    signal?: AbortSignal,
    context?: WeixinReplyContext,
  ): Promise<boolean> {
    signal = this.closed ? undefined : signal;
    context ??= {
      actorId: target.conversationId,
      contextToken: undefined,
    };
    const fileClient = this.options.fileClient;
    const file = Buffer.from(text, "utf8");
    if (
      fileClient === undefined
      || file.length > maximumWeixinOutboundFileBytes
    ) {
      return false;
    }
    const previewLength = safePrefixLength(
      text,
      maximumChunkCharacters - previewNotice.length,
    );
    const preview = text.slice(0, previewLength) + previewNotice;
    await this.send(target, preview, maximumChunks, signal, context);
    if (!this.access.isAllowed({
      target,
      actorId: context.actorId,
    })) {
      await this.invalidateContext(target, context.contextToken);
      throw new WeixinOutboxError("unauthorized-recipient");
    }
    try {
      const input = {
        actorId: context.actorId,
        ...(context.contextToken === undefined
          ? {}
          : { contextToken: context.contextToken }),
        fileName: finalAnswerFileName,
        file,
      };
      try {
        if (signal) {
          await fileClient.sendFile(input, signal);
        } else {
          await fileClient.sendFile(input);
        }
      } catch (error) {
        if (isRejectedReplyContext(error)) {
          await this.invalidateContext(target, context.contextToken);
        }
        throw error;
      }
    } catch (error) {
      if (isRejectedReplyContext(error)) {
        // 已确认上下文被拒绝时，回退文本仍会复用同一个失效 token，
        // 只会制造第二次无意义的 sendmessage 请求。
        throw error;
      }
      await this.send(
        target,
        fileFailureNotice + text.slice(previewLength),
        maximumChunks - 1,
        signal,
        context,
      );
      throw error;
    }
    return true;
  }

  private async send(
    target: ConversationTarget,
    text: string,
    maximumChunkCount = maximumChunks,
    signal?: AbortSignal,
    context = this.contexts.get(target),
  ): Promise<void> {
    signal = this.closed ? undefined : signal;
    // The upstream Weixin implementation treats context_token as optional.
    // A known, authorized Conversation can still receive a message after the
    // previous token has expired; omit the stale token until the next inbound
    // message refreshes it.
    context ??= {
      actorId: target.conversationId,
      contextToken: undefined,
    };
    for (const chunk of splitWeixinText(text, maximumChunkCount)) {
      if (!this.access.isAllowed({
        target,
        actorId: context.actorId,
      })) {
        await this.invalidateContext(target, context.contextToken);
        throw new WeixinOutboxError("unauthorized-recipient");
      }
      try {
        const input = {
          actorId: context.actorId,
          ...(context.contextToken === undefined
            ? {}
            : { contextToken: context.contextToken }),
          text: chunk,
        };
        if (signal) {
          await this.client.sendText(input, signal);
        } else {
          await this.client.sendText(input);
        }
      } catch (error) {
        if (isRejectedReplyContext(error)) {
          await this.invalidateContext(target, context.contextToken);
        }
        throw error;
      }
    }
  }

  private async sendImage(
    target: ConversationTarget,
    path: string,
    signal?: AbortSignal,
    context = this.contexts.get(target),
  ): Promise<void> {
    signal = this.closed ? undefined : signal;
    context ??= {
      actorId: target.conversationId,
      contextToken: undefined,
    };
    if (!this.access.isAllowed({
      target,
      actorId: context.actorId,
    })) {
      await this.invalidateContext(target, context.contextToken);
      throw new WeixinOutboxError("unauthorized-recipient");
    }
    const client = this.options.imageClient;
    if (client === undefined) {
      throw new WeixinOutboxError("image-sender-unavailable");
    }
    const image = await (this.options.readImage ?? readWeixinOutboundImage)(
      path,
    );
    if (!this.access.isAllowed({
      target,
      actorId: context.actorId,
    })) {
      await this.invalidateContext(target, context.contextToken);
      throw new WeixinOutboxError("unauthorized-recipient");
    }
    const input = {
      actorId: context.actorId,
      ...(context.contextToken === undefined
        ? {}
        : { contextToken: context.contextToken }),
      image,
    };
    try {
      if (signal) {
        await client.sendImage(input, signal);
      } else {
        await client.sendImage(input);
      }
    } catch (error) {
      if (isRejectedReplyContext(error)) {
        await this.invalidateContext(target, context.contextToken);
      }
      throw error;
    }
  }

  sendChannelImage(
    target: ConversationTarget,
    imagePath: string,
  ): Promise<void> {
    return this.delivery.runOrdered(
      target.conversationId,
      (signal) => this.sendImage(
        target,
        imagePath,
        signal,
        this.contexts.get(target),
      ),
    );
  }

  private async invalidateContext(
    target: ConversationTarget,
    expectedContextToken?: string,
  ): Promise<void> {
    if (expectedContextToken === undefined) {
      return;
    }
    if (!this.contexts.removeIf(target, expectedContextToken)) {
      return;
    }
    await this.options.onReplyContextInvalidated?.(target, expectedContextToken);
  }

  private enqueueText(
    target: ConversationTarget,
    text: string,
    critical: boolean,
  ): boolean {
    return this.delivery.enqueue(
      target.conversationId,
      (signal) => this.send(
        target,
        text,
        maximumChunks,
        signal,
        this.contexts.get(target),
      ),
      critical,
    );
  }

  private matches(target: ConversationTarget): boolean {
    return target.surface === "weixin"
      && target.accountId === this.accountId;
  }

  /**
   * 微信不需要为审批预热渠道状态：占用单次回复窗口的事件已由投递策略判定，
   * 审批本身由 InteractionPort 直接发送。保留共享交互准备入口，使
   * PendingInteractionRegistry 的准备与清理契约在本渠道同样可执行。
   */
  prepareInteraction(request: InteractionRequest): void {
    void request;
  }

  finishInteraction(request: InteractionRequest, decision: InteractionDecision): void {
    void request;
    void decision;
  }
}

function splitWeixinText(
  value: string,
  maximumChunkCount = maximumChunks,
): string[] {
  const maximumCharacters = maximumChunkCharacters * maximumChunkCount;
  let text = value;
  if (text.length > maximumCharacters) {
    text = safePrefix(
      text,
      maximumCharacters - truncationNotice.length,
    ) + truncationNotice;
  }
  const chunks: string[] = [];
  while (text.length > 0) {
    const end = safePrefixLength(text, maximumChunkCharacters);
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  return chunks.length === 0 ? [emptyCodexResponseText] : chunks;
}

function safePrefix(value: string, maximumLength: number): string {
  return value.slice(0, safePrefixLength(value, maximumLength));
}

function safePrefixLength(value: string, maximumLength: number): number {
  let length = Math.min(value.length, maximumLength);
  if (
    length > 0
    && length < value.length
    && isHighSurrogate(value.charCodeAt(length - 1))
  ) {
    length -= 1;
  }
  return length;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function weixinOutputErrorMetadata(
  error: unknown,
): Record<string, unknown> {
  if (error instanceof WeixinOutboxError) {
    return { ...surfaceErrorMetadata(error), errorCode: error.code };
  }
  if (error instanceof WeixinProtocolError) {
    return {
      ...surfaceErrorMetadata(error),
      errorCode: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.returnCode === undefined
        ? {}
        : { returnCode: error.returnCode }),
    };
  }
  if (error instanceof WeixinOutboundImageError) {
    return { ...surfaceErrorMetadata(error), errorCode: error.code };
  }
  return surfaceErrorMetadata(error);
}

function isRejectedReplyContext(error: unknown): boolean {
  return error instanceof WeixinProtocolError
    && error.code === "api-error"
    && error.returnCode === -2;
}

/**
 * 只有能证明消息未送达的失败才重试：平台业务返回码拒绝，以及 429 或 5xx 服务端拒绝。
 * 超时、网络中断和响应不可解析都可能已经送达，重试会产生重复气泡；回复上下文失效
 * （返回码 -2）是永久错误，由调用方作废上下文后交给用户重新发送。
 */
function weixinSendRetryDelay(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof WeixinProtocolError)) {
    return undefined;
  }
  if (error.code === "api-error" && error.returnCode !== -2) {
    return exponentialRetryDelay(attempt);
  }
  if (
    error.code === "http-error"
    && (error.status === 429 || (error.status !== undefined && error.status >= 500))
  ) {
    return exponentialRetryDelay(attempt);
  }
  return undefined;
}
