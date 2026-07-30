import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type ConversationTarget,
  type OutputEvent,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import {
  OperationUpdateBuffer,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";
import type {
  OperationUpdateDisplay,
  SurfaceOutputPort,
} from "../types.js";
import {
  createTurnStartedPresentation,
  renderPlainLifecyclePresentation,
} from "../lifecycle-presentation.js";
import {
  contentTruncatedText,
  emptyCodexResponseText,
  formatCliInput,
  formatCodexWarning,
  formatConnectionLost,
} from "../output-copy.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpStatusUpdate,
  formatRuntimeRateLimitUpdate,
} from "../runtime-status-format.js";
import { PlanProgressTracker } from "../plan-presentation.js";

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
import { WeixinReplyContextStore } from "./reply-context-store.js";
import {
  formatWeixinCommandText,
  renderWeixinTurnCompleted,
} from "./command-renderer.js";
import { formatWeixinFinalText } from "./final-text-format.js";
import {
  formatWeixinOperation,
  formatWeixinOperationSummary,
} from "./operation-format.js";
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
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  onReplyContextInvalidated?: (target: ConversationTarget) => Promise<void>;
  imageClient?: Pick<WeixinImageSendProtocolClient, "sendImage">;
  fileClient?: Pick<WeixinFileSendProtocolClient, "sendFile">;
  readImage?: typeof readWeixinOutboundImage;
  typing?: Pick<WeixinTypingController, "close" | "start" | "stop">;
}

export class WeixinOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly operationUpdates =
    new OperationUpdateBuffer<ConversationTarget>();
  private readonly planUpdates = new Map<string, PlanProgressTracker>();
  private readonly accountId: string;
  private closed = false;

  constructor(
    accountId: string,
    private readonly client: Pick<WeixinProtocolClient, "sendText">,
    private readonly contexts: WeixinReplyContextStore,
    private readonly access: SurfaceAccessPolicy,
    logger: Logger,
    private readonly options: WeixinOutboxOptions = {},
  ) {
    this.accountId = validateWeixinAccountId(accountId);
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
    if (event.type === "turn.started") {
      this.options.typing?.start(event.target);
      this.delivery.enqueue(
        event.target.conversationId,
        () => this.send(
          event.target,
          renderPlainLifecyclePresentation(
            createTurnStartedPresentation(),
          ),
        ),
        true,
      );
      return;
    }
    if (event.type === "operation.updated") {
      const imagePath = event.operation.imagePath;
      if (
        event.operation.kind === "imageGeneration"
        && event.operation.status === "completed"
        && imagePath !== undefined
      ) {
        this.delivery.enqueue(
          event.target.conversationId,
          () => this.sendImage(event.target, imagePath),
          true,
        );
      }
      if (
        this.options.operationUpdateDisplay === "hidden"
        || event.operation.status === "running"
      ) {
        return;
      }
      if (
        this.operationUpdates.accept(
          turnKey(event.threadId, event.turnId),
          event.operation,
          event.target,
        )
      ) {
        return;
      }
      const rendered = formatWeixinOperation(
        event.operation,
        this.options.operationUpdateDisplay === "compact"
          ? "compact"
          : "full",
      );
      this.delivery.enqueue(
        event.target.conversationId,
        () => this.send(event.target, rendered),
        true,
      );
      return;
    }
    if (event.type === "plan.updated") {
      if (!this.options.planUpdatesEnabled) {
        return;
      }
      const key = turnKey(event.threadId, event.turnId);
      const tracker = this.planUpdates.get(key) ?? new PlanProgressTracker();
      this.planUpdates.set(key, tracker);
      for (const presentation of tracker.accept(event)) {
        this.delivery.enqueue(
          event.target.conversationId,
          () => this.send(event.target, presentation.text),
          true,
        );
      }
      return;
    }
    if (
      (
        event.type === "text.completed"
        && event.phase !== "commentary"
      )
      || event.type === "turn.completed"
    ) {
      if (event.type === "turn.completed") {
        this.planUpdates.delete(turnKey(event.threadId, event.turnId));
      }
      this.flushOperationUpdates(
        event.target,
        turnKey(event.threadId, event.turnId),
      );
    }
    const rendered = this.render(event);
    if (rendered === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      () => this.sendEvent(event, rendered),
      isCriticalOutputEvent(event),
    );
  }

  notifyText(target: ConversationTarget, text: string): boolean {
    if (this.closed || !this.matches(target)) {
      return false;
    }
    return this.delivery.enqueue(
      target.conversationId,
      () => this.send(target, text),
      true,
    );
  }

  deliverText(target: ConversationTarget, text: string): Promise<void> {
    if (this.closed || !this.matches(target)) {
      return Promise.reject(new Error("微信输出目标无效或队列已关闭"));
    }
    return this.delivery.runOrdered(
      target.conversationId,
      () => this.send(target, text),
    );
  }

  deliverTextSequence(
    target: ConversationTarget,
    texts: readonly string[],
  ): Promise<void> {
    if (this.closed || !this.matches(target)) {
      return Promise.reject(new Error("微信输出目标无效或队列已关闭"));
    }
    return this.delivery.runOrdered(
      target.conversationId,
      async () => {
        for (const text of texts) {
          await this.send(target, text);
        }
      },
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.delivery.close();
      return;
    }
    this.closed = true;
    for (const { target, summary } of this.operationUpdates.drain()) {
      this.enqueueOperationSummary(target, summary);
    }
    await this.options.typing?.close();
    await this.delivery.close();
    this.operationUpdates.clear();
    this.planUpdates.clear();
    this.contexts.clear();
  }

  private flushOperationUpdates(
    target: ConversationTarget,
    key: string,
  ): void {
    const buffered = this.operationUpdates.take(key);
    if (buffered === null) {
      return;
    }
    this.enqueueOperationSummary(target, buffered.summary);
  }

  private enqueueOperationSummary(
    target: ConversationTarget,
    summary: OperationUpdateSummary,
  ): void {
    const text = formatWeixinOperationSummary(
      summary,
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
    );
    this.delivery.enqueue(
      target.conversationId,
      () => this.send(target, text),
      true,
    );
  }

  private render(event: OutputEvent): string | null {
    switch (event.type) {
      case "user.message":
        return formatCliInput(event.text);
      case "text.completed":
        if (event.phase === "commentary") {
          return null;
        }
        return event.text.trim().length === 0
          ? emptyCodexResponseText
          : formatWeixinFinalText(event.text);
      case "turn.completed": {
        return formatWeixinCommandText(renderWeixinTurnCompleted(event));
      }
      case "connection.lost":
        return formatConnectionLost(visibleMessage(event.message));
      case "warning":
        return formatCodexWarning(visibleMessage(event.message));
      case "account.updated":
        return formatWeixinCommandText(
          formatRuntimeAccountUpdate(event.authMode, event.planType),
        );
      case "account.rateLimits.updated":
        return formatWeixinCommandText(
          formatRuntimeRateLimitUpdate(event.rateLimits),
        );
      case "mcp.status.updated":
        return formatWeixinCommandText(
          formatRuntimeMcpStatusUpdate(event),
        );
      case "plan.updated":
        return null;
      default:
        return null;
    }
  }

  private async sendEvent(event: OutputEvent, text: string): Promise<void> {
    if (
      event.type === "turn.completed"
      || event.type === "connection.lost"
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
      && await this.sendLongFinalAnswer(event.target, text)
    ) {
      return;
    }
    await this.send(event.target, text);
  }

  private async sendLongFinalAnswer(
    target: ConversationTarget,
    text: string,
  ): Promise<boolean> {
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
    await this.send(target, preview);
    const context = this.contexts.get(target);
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
    if (!this.access.isAllowed({
      target,
      actorId: context.actorId,
    })) {
      await this.invalidateContext(target);
      throw new WeixinOutboxError("unauthorized-recipient");
    }
    try {
      await fileClient.sendFile({
        actorId: context.actorId,
        contextToken: context.contextToken,
        fileName: finalAnswerFileName,
        file,
      });
    } catch (error) {
      await this.send(
        target,
        fileFailureNotice + text.slice(previewLength),
        maximumChunks - 1,
      );
      throw error;
    }
    return true;
  }

  private async send(
    target: ConversationTarget,
    text: string,
    maximumChunkCount = maximumChunks,
  ): Promise<void> {
    const context = this.contexts.get(target);
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
    for (const chunk of splitWeixinText(text, maximumChunkCount)) {
      if (!this.access.isAllowed({
        target,
        actorId: context.actorId,
      })) {
        await this.invalidateContext(target);
        throw new WeixinOutboxError("unauthorized-recipient");
      }
      await this.client.sendText({
        actorId: context.actorId,
        contextToken: context.contextToken,
        text: chunk,
      });
    }
  }

  private async sendImage(
    target: ConversationTarget,
    path: string,
  ): Promise<void> {
    const context = this.contexts.get(target);
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
    if (!this.access.isAllowed({
      target,
      actorId: context.actorId,
    })) {
      await this.invalidateContext(target);
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
      await this.invalidateContext(target);
      throw new WeixinOutboxError("unauthorized-recipient");
    }
    await client.sendImage({
      actorId: context.actorId,
      contextToken: context.contextToken,
      image,
    });
  }

  private async invalidateContext(
    target: ConversationTarget,
  ): Promise<void> {
    this.contexts.remove(target);
    await this.options.onReplyContextInvalidated?.(target);
  }

  private matches(target: ConversationTarget): boolean {
    return target.surface === "weixin"
      && target.accountId === this.accountId;
  }

}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
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

function visibleMessage(value: string): string {
  return value.replaceAll("[REDACTED]", "[已隐藏]");
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
