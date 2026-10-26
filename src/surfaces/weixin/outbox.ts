import { isPersistentOutput, isSupportedPersistentOutput } from "../persistent-output.js";
import { SnapshotDelivery } from "../snapshot-delivery.js";
import { TurnRetryMessages } from "../turn-retry-presentation.js";
import { DeliveryReceipt, captureDelivery, checkpointDelivery, type DeliveryCheckpoint } from "../delivery-receipt.js";
import type { Logger } from "pino";
import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";
import { withSurfaceOutputDiagnostics } from "../diagnostics.js";

import type {
  ConversationTarget,
  OutputEvent,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { ContextCompactionNotices } from "../operation-presentation.js";
import { resolveSurfaceDelivery, shouldHideRoutineNotification, surfaceDeliveryCoalesceKey } from "../delivery-policy.js";
import { exponentialRetryDelay, withDeliveryRetry } from "../delivery-retry.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import type { SurfaceOutputPort, SurfaceMessageDisplaySettings, SurfaceDeliverySource } from "../types.js";
import { assertChannelFileName, assertWeixinChannelMediaBytes, maximumWeixinChannelFileBytes, readBoundedLocalFile, type ChannelFileMediaType } from "../bounded-local-file.js";
import {
  createTurnStartedPresentation,
  createAutoApprovalReviewPresentation,
  createHookCompletedPresentation,
  isHiddenAutoApprovalReview,
  shouldHideTurnCompleted,
  renderPlainLifecyclePresentation,
} from "../lifecycle-presentation.js";
import {
  contentTruncatedText,
  emptyCodexResponseText,
  formatCodexWarning,
  formatConnectionRestored,
  formatConversationIdleReleased,
  visibleUpstreamMessage,
} from "../output-copy.js";

import { validateWeixinAccountId } from "./credential-store.js";
import {
  maximumWeixinOutboundFileBytes,
  type WeixinFileSendProtocolClient,
  type WeixinImageSendProtocolClient,
  type WeixinProtocolClient,
} from "./protocol-client.js";
import { WeixinProtocolError } from "./protocol-types.js";
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
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";

const maximumChunkCharacters = 4_000;
const maximumChunks = 5;
const maximumSendAttempts = 3;
const maximumSendRetryDelayMs = 5_000;
const truncationNotice = `\n\n[${contentTruncatedText}]`;
const previewNotice = "\n\n[内容预览]";
const fileFailureNotice = "[文件发送失败，已改为分段文本]\n\n";
const finalAnswerFileName = "codex-final-answer.txt";

export type WeixinOutboxErrorCode =
  | "markdown-layout-too-long"
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
  displaySettings?: SurfaceMessageDisplaySettings;
  capacity?: number;
  closeTimeoutMs?: number;
  onReplyContextInvalidated?: (
    target: ConversationTarget,
    expectedContextToken?: string,
  ) => Promise<void>;
  imageClient?: Pick<WeixinImageSendProtocolClient, "sendImage">;
  fileClient?: Pick<WeixinFileSendProtocolClient, "sendFile">;
  readImage?: typeof readWeixinOutboundImage;
}

export class WeixinOutbox implements SurfaceOutputPort {
  private readonly snapshots = new SnapshotDelivery();
  private readonly retryMessages = new TurnRetryMessages<void>();
  private readonly compactionNotices = new ContextCompactionNotices();
  private readonly delivery: ConversationDeliveryQueue;
  private readonly accountId: string;
  private readonly client: Pick<WeixinProtocolClient, "sendText">;
  private readonly logger: Logger;
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
    this.logger = logger;
    this.client = {
      sendText: (input, signal, beforeSend) => this.withSendRetry(
        "sendText",
        () => {
          beforeSend?.();
          return client.sendText(input, signal, beforeSend);
        },
        signal,
      ),
    };
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Weixin",
      maximumPendingOperations: 512,
      ...(options.capacity === undefined
        ? {}
        : { capacity: options.capacity }),
      ...(options.closeTimeoutMs === undefined
        ? {}
        : { closeTimeoutMs: options.closeTimeoutMs }),
      errorMetadata: weixinOutputErrorMetadata,
    });
  }

  handle(event: OutputEvent, context?: { liveAdmitted: true; completion?: "brief" | "detailed" }, signal?: AbortSignal): void | Promise<void> {
    if (
      this.closed
      || event.target.surface !== "weixin"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    if (!DeliveryReceipt.current()) this.observe(event);
    if (!DeliveryReceipt.current() && event.type === "turn.completed" && !context?.completion && this.shouldSettleLiveCompletion(event)) {
      return this.settleLiveCompletion(event, signal ?? new AbortController().signal, () => true);
    }
    withSurfaceOutputDiagnostics(this.logger, event, () => this.handleEvent(event, context?.completion));
  }

  observe(event: OutputEvent): void {
    if (this.closed || !this.matches(event.target)) return;
    this.snapshots.observe(event);
    this.retryMessages.observe(event, false);
  }

  deliverSnapshot(event: OutputEvent, signal: AbortSignal, authorized: () => boolean): Promise<void> {
    return this.snapshots.run(event, signal, authorized, () => {
      if (this.closed || !this.matches(event.target) || (event.type !== "hook.completed" && event.type !== "turn.retry")) {
        throw new Error("状态投递目标无效或已关闭");
      }
      withSurfaceOutputDiagnostics(this.logger, event, () => this.handleEvent(event));
    });
  }

  retains(event: OutputEvent): boolean {
    if (shouldHideRoutineNotification(event, this.options.displaySettings?.(event.target).routineNotificationsEnabled ?? true)) return false;
    if (event.type === "turn.completed" && this.shouldSettleLiveCompletion(event)) return false;
    return isPersistentOutput(event);
  }

  liveCompletionDisplay(event: Extract<OutputEvent, { type: "turn.completed" }>): "off" | "brief" | "detailed" {
    const mode = this.options.displaySettings?.(event.target).completion ?? "detailed";
    return mode === "off" && !shouldHideTurnCompleted(event, mode) ? "detailed" : mode;
  }

  shouldSettleLiveCompletion(event: Extract<OutputEvent, { type: "turn.completed" }>): boolean {
    return this.liveCompletionDisplay(event) === "off";
  }

  async settleLiveCompletion(event: Extract<OutputEvent, { type: "turn.completed" }>, signal: AbortSignal, authorized: () => boolean): Promise<void> {
    const actorId = this.contexts.get(event.target)?.actorId ?? event.target.conversationId;
    await this.snapshots.run(event, signal, () => authorized() && !this.closed && this.matches(event.target)
      && this.access.isAllowed({ target: event.target, actorId }), () => this.discardLiveCompletion(), false);
  }

  discardLiveCompletion(): void {
    // Weixin owns no Turn stream. Its incoming reply context belongs to the
    // Conversation; hiding a notification must not invalidate or consume it.
  }

  async deliver(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized?: () => boolean, _source?: SurfaceDeliverySource, context?: { completion: "brief" | "detailed" }): Promise<void> {
    if (this.closed || !this.matches(event.target)) throw new Error("可靠输出目标无效或已关闭");
    signal.throwIfAborted();
    if (isHiddenAutoApprovalReview(event)) return;
    if (!isSupportedPersistentOutput(event) || resolveSurfaceDelivery("weixin", event).disposition === "ignore") {
      throw new Error("微信持久输出类型不受支持");
    }
    await captureDelivery(() => {
      void this.handle(event, { liveAdmitted: true, completion: context?.completion ?? "detailed" });
    }, signal, checkpoint, { requireConfirmation: true, beforeSend: () => {
      signal.throwIfAborted();
      if (this.closed || authorized?.() !== true) throw new Error("微信可靠输出授权已变化");
    } });
  }

  private handleEvent(event: OutputEvent, completion?: "brief" | "detailed"): void {
    if (DeliveryReceipt.current()?.transient !== false
      && shouldHideRoutineNotification(event, this.options.displaySettings?.(event.target).routineNotificationsEnabled ?? true)) return;
    // 渠道投递策略只在这里判定一次：微信的单次回复窗口只保留生命周期、终态与全局空闲
    // 通知、连接恢复和上下文压缩，推理、计划、其他操作不占用该预算（详见 delivery-policy.ts）。
    const decision = resolveSurfaceDelivery("weixin", event);
    if (decision.disposition === "ignore") {
      return;
    }
    if (event.type === "turn.retry") {
      const run = this.retryMessages.prepare(event, true);
      if (run) this.delivery.enqueue(event.target.conversationId,
        (signal) => run((text) => this.sendEvent(event, text, signal, this.contexts.get(event.target))), true,
        { coalesceKey: surfaceDeliveryCoalesceKey(event)! });
      return;
    }
    if (event.type === "turn.started") {
      this.enqueueText(
        event.target,
        renderPlainLifecyclePresentation(
          createTurnStartedPresentation(
            event.background ? event.threadId : undefined,
            event.identity,
            event.approvalsReviewer,
            event,
          ),
        ),
        true,
      );
      return;
    }
    const rendered = this.render(event, completion);
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
    await this.delivery.close();
    this.retryMessages.clear();
    this.contexts.clear();
  }

  /**
   * 有界重试只覆盖能证明平台未接受请求的失败，文本、图片与文件共用同一判定；
   * 超时与网络中断一律不重试，避免重复气泡或重复上传。
   */
  private withSendRetry<T>(
    operation: "sendText" | "sendImage" | "sendFile",
    call: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return withDeliveryRetry(
      {
        component: "Weixin",
        operation,
        maximumAttempts: maximumSendAttempts,
        maximumDelayMs: maximumSendRetryDelayMs,
        delayMs: weixinSendRetryDelay,
        logger: this.logger,
        metadata: weixinOutputErrorMetadata,
      },
      () => {
        this.assertSendActive(signal);
        return call();
      },
      signal,
    );
  }

  private assertSendActive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("微信输出队列已关闭");
    DeliveryReceipt.current()?.beforeSend?.();
  }

  private render(event: OutputEvent, completion?: "brief" | "detailed"): string | null {
    switch (event.type) {
      case "connection.restored":
        return formatWeixinCommandText(formatConnectionRestored(visibleUpstreamMessage(event.message)));
      case "hook.completed":
        return formatWeixinCommandText(
          renderPlainLifecyclePresentation(createHookCompletedPresentation(event)),
          { structuredFields: true },
        );
      case "autoApprovalReview.updated": {
        const presentation = createAutoApprovalReviewPresentation(event, this.options.displaySettings?.(event.target).presentationDetail ?? "basic");
        return presentation ? formatWeixinCommandText(
          renderPlainLifecyclePresentation(presentation),
          { structuredFields: true },
        ) : null;
      }
      case "operation.updated":
        return this.compactionNotices.accept(event, DeliveryReceipt.current() !== undefined);
      case "text.completed":
        // handleEvent 已通过共享投递策略；空 phase 的完成正文同样需要渲染。
        return event.text.trim().length === 0
          ? emptyCodexResponseText
          : formatWeixinFinalText(
              `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`,
            );
      case "turn.completed": {
        return formatWeixinCommandText(
          renderWeixinTurnCompleted(
            event,
            this.options.displaySettings?.(event.target).presentationDetail ?? "basic",
            completion ?? (this.liveCompletionDisplay(event) === "brief" ? "brief" : "detailed"),
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
    this.assertSendActive(signal);
    if (
      event.type === "text.completed"
      && planWeixinText(text, maximumChunks).truncated
      && await this.sendLongFinalAnswer(event.target, text, event.text, signal, context)
    ) {
      return;
    }
    await this.send(event.target, text, maximumChunks, signal, context);
  }

  private async sendLongFinalAnswer(
    target: ConversationTarget,
    text: string,
    originalText: string,
    signal?: AbortSignal,
    context?: WeixinReplyContext,
  ): Promise<boolean> {
    this.assertSendActive(signal);
    context ??= {
      actorId: target.conversationId,
      contextToken: undefined,
    };
    const fileClient = this.options.fileClient;
    const file = Buffer.from(originalText, "utf8");
    if (
      fileClient === undefined
      || file.length > maximumWeixinOutboundFileBytes
    ) {
      return false;
    }
    const [previewContent, remainingContent] = splitWeixinMarkdownChunk(
      text,
      maximumChunkCharacters - previewNotice.length,
    );
    DeliveryReceipt.current()?.markContentIncomplete();
    const preview = previewContent + previewNotice;
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
        const ownerGuard = DeliveryReceipt.current()?.beforeSend;
        const beforeSend = ownerGuard === undefined ? undefined : (): undefined => { ownerGuard(); };
        await checkpointDelivery("sendFile", () => this.withSendRetry(
          "sendFile",
          () => fileClient.sendFile(input, signal, beforeSend),
          signal,
        ), isDefinitelyRejectedWeixinSend);
        DeliveryReceipt.current()?.confirmCompleteContent();
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
        fileFailureNotice + remainingContent,
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
    this.assertSendActive(signal);
    // The upstream Weixin implementation treats context_token as optional.
    // A known, authorized Conversation can still receive a message after the
    // previous token has expired; omit the stale token until the next inbound
    // message refreshes it.
    context ??= {
      actorId: target.conversationId,
      contextToken: undefined,
    };
    const plan = planWeixinText(text, maximumChunkCount);
    if (plan.truncated) DeliveryReceipt.current()?.markContentIncomplete();
    const actorId = context.actorId;
    // Keep both the result owner and current recipient authorization across
    // retry waits and asynchronous credential acquisition, through to HTTP.
    const beforeSend = (): undefined => {
      this.assertSendActive(signal);
      if (!this.access.isAllowed({ target, actorId })) throw new WeixinOutboxError("unauthorized-recipient");
      return undefined;
    };
    for (const chunk of plan.chunks) {
      this.assertSendActive(signal);
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
        await checkpointDelivery("sendText", () => this.client.sendText(input, signal, beforeSend), isDefinitelyRejectedWeixinSend);
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
    beforeSend?: () => undefined,
  ): Promise<void> {
    beforeSend?.();
    this.assertSendActive(signal);
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
      if (beforeSend) {
        await checkpointDelivery("sendImage", () => client.sendImage(input, signal, beforeSend), isDefinitelyRejectedWeixinSend);
        return;
      }
      await checkpointDelivery("sendImage", () => this.withSendRetry(
        "sendImage",
        () => (signal
          ? client.sendImage(input, signal)
          : client.sendImage(input)),
        signal,
      ), isDefinitelyRejectedWeixinSend);
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
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const context = this.contexts.get(target);
    return this.delivery.runOrdered(
      target.conversationId,
      (active) => this.sendImage(
        target,
        imagePath,
        active,
        context,
        () => this.assertExplicitMediaCurrent(target, context, isCurrent, active),
      ),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    );
  }

  sendChannelFile(target: ConversationTarget, path: string, fileName: string, isCurrent: () => boolean, mediaType: ChannelFileMediaType = "file", signal?: AbortSignal): Promise<void> {
    const context = this.contexts.get(target);
    const lifetime = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    return this.delivery.runOrdered(target.conversationId, async active => {
      const guard = () => this.assertExplicitMediaCurrent(target, context, isCurrent, active);
      guard();
      assertChannelFileName(fileName);
      const bytes = await readBoundedLocalFile(path, maximumWeixinChannelFileBytes);
      assertWeixinChannelMediaBytes(bytes, mediaType);
      guard();
      const client = this.options.fileClient;
      if (!client) throw new Error("微信文件发送不可用");
      try {
        await checkpointDelivery("sendFile", () => client.sendFile({ actorId: context!.actorId,
          contextToken: context!.contextToken!, fileName, file: bytes, mediaType }, active, guard), isDefinitelyRejectedWeixinSend);
      } catch (error) {
        if (isRejectedReplyContext(error)) await this.invalidateContext(target, context?.contextToken);
        throw error;
      }
    }, lifetime);
  }

  private assertExplicitMediaCurrent(target: ConversationTarget, context: ReturnType<WeixinReplyContextStore["get"]>, isCurrent: () => boolean, signal: AbortSignal): undefined {
    this.assertSendActive(signal);
    const latest = this.contexts.get(target);
    if (!isCurrent() || !context?.contextToken || latest?.contextToken !== context.contextToken
      || latest.actorId !== context.actorId || !this.access.isAllowed({ target, actorId: context.actorId })) {
      throw new Error("微信原 Thread、授权或回复上下文已失效");
    }
    return undefined;
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

function planWeixinText(
  value: string,
  maximumChunkCount = maximumChunks,
): { chunks: string[]; truncated: boolean } {
  let text = value;
  const chunks: string[] = [];
  while (text.length > maximumChunkCharacters && chunks.length < maximumChunkCount - 1) {
    const [head, tail] = splitWeixinMarkdownChunk(text, maximumChunkCharacters);
    chunks.push(head);
    text = tail;
  }
  const truncated = text.length > maximumChunkCharacters;
  if (truncated) {
    const [head] = splitWeixinMarkdownChunk(text, maximumChunkCharacters - truncationNotice.length);
    chunks.push(head + truncationNotice);
  } else if (text.length > 0) chunks.push(text);
  return { chunks: chunks.length === 0 ? [emptyCodexResponseText] : chunks, truncated };
}

/** Keep each bubble's code region complete; added delimiters consume the same UTF-16 budget. */
function splitWeixinMarkdownChunk(text: string, limit: number): [string, string] {
  let end = safePrefixLength(text, limit);
  const newline = text.lastIndexOf("\n", end - 1);
  if (newline >= Math.floor(end * 0.75)) end = newline + 1;
  while (end > 0) {
    let offset = 0;
    let fence: MarkdownFence | undefined;
    let delimiterStart: number | undefined;
    for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      const next = advanceMarkdownFence(fence, line);
      if (offset < end && offset + line.length > end && next !== fence) {
        delimiterStart = offset;
        break;
      }
      if (offset + line.length > end) break;
      fence = next;
      offset += line.length;
      if (offset >= end) break;
    }
    if (delimiterStart !== undefined) {
      end = delimiterStart;
      continue;
    }
    const head = text.slice(0, end);
    const closing = fence === undefined ? "" : `${head.endsWith("\n") ? "" : "\n"}${fence.marker}`;
    if (end + closing.length > limit) {
      end = safePrefixLength(text, limit - closing.length);
      const previousNewline = text.lastIndexOf("\n", end - 1);
      if (previousNewline >= Math.floor(end * 0.75)) end = previousNewline + 1;
      continue;
    }
    const tail = fence === undefined ? text.slice(end) : `${fence.opening}\n${text.slice(end)}`;
    if (tail.length >= text.length) break;
    return [head + closing, tail];
  }
  // A delimiter that cannot fit must not be sliced into executable-looking prose.
  throw new WeixinOutboxError("markdown-layout-too-long");
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
 * 只有能证明消息未送达的失败才重试：平台业务返回码拒绝，以及 429 限流拒绝。
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
    && error.status === 429
  ) {
    return exponentialRetryDelay(attempt);
  }
  return undefined;
}

function isDefinitelyRejectedWeixinSend(error: unknown): boolean {
  return error instanceof WeixinProtocolError
    && (error.code === "api-error" || (error.code === "http-error" && error.status === 429));
}
