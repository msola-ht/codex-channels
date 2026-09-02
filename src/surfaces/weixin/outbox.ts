import type { Logger } from "pino";
import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";

import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
  ProviderModelUsageEstimate,
} from "../../application/index.js";
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
import { isExecutionOperation, shouldDisplayOperation } from "../operation-presentation.js";
import type {
  OperationUpdateDisplay,
  SurfaceOutputPort,
} from "../types.js";
import {
  createSubagentContactedPresentation,
  createSubagentStartedPresentation,
  createTurnReasoningPresentation,
  createTurnStartedPresentation,
  renderPlainLifecyclePresentation,
} from "../lifecycle-presentation.js";
import {
  contentTruncatedText,
  emptyCodexResponseText,
  formatCliInput,
  formatCodexWarning,
  formatConnectionLost,
  formatConnectionRestored,
  formatThreadAvailability,
  visibleUpstreamMessage,
} from "../output-copy.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpOAuthCompleted,
  formatRuntimeMcpStatusUpdate,
  formatRuntimeRateLimitUpdate,
} from "../runtime-status-format.js";
import { TurnPlanProgressState } from "../plan-presentation.js";

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
  renderWeixinSubagentCompleted,
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
  reasoningEnabled?: boolean;
  exchangeRate?: () => ExchangeRateSnapshot | null;
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency;
  debugEnabled?: boolean;
  remainingUsage?: (
    model: string,
    requestStartedAtMs?: number,
    modelProvider?: string,
  ) => Promise<ProviderModelUsageEstimate | null>;
  onReplyContextInvalidated?: (
    target: ConversationTarget,
    expectedContextToken?: string,
  ) => Promise<void>;
  imageClient?: Pick<WeixinImageSendProtocolClient, "sendImage">;
  fileClient?: Pick<WeixinFileSendProtocolClient, "sendFile">;
  readImage?: typeof readWeixinOutboundImage;
  typing?: Pick<WeixinTypingController, "close" | "start" | "stop">;
}

export class WeixinOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly operationUpdates =
    new OperationUpdateBuffer<ConversationTarget>();
  private readonly activeOperations = new Set<string>();
  private readonly pendingApprovalOperations = new Set<string>();
  private readonly reasoningGenerations = new Map<string, number>();
  private readonly reasoningDisplayedGenerations = new Map<string, number>();
  private readonly planProgress = new TurnPlanProgressState();
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

  async handle(event: OutputEvent): Promise<void> {
    if (
      this.closed
      || event.target.surface !== "weixin"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    if (event.type === "turn.started") {
      this.clearExecutionTurns(event.threadId);
      this.options.typing?.start(event.target);
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
    if (event.type === "turn.reasoning") {
      if (this.options.reasoningEnabled === false) {
        return;
      }
      if (this.hasActiveOperation(event.threadId, event.turnId)) {
        return;
      }
      const turn = turnKey(event.threadId, event.turnId);
      const generation = this.reasoningGenerations.get(turn) ?? 0;
      if (this.reasoningDisplayedGenerations.get(turn) === generation) {
        return;
      }
      this.reasoningDisplayedGenerations.set(turn, generation);
      this.enqueueText(
        event.target,
        renderPlainLifecyclePresentation(
          createTurnReasoningPresentation(
            event.background ? event.threadId : undefined,
            undefined,
            false,
          ),
        ),
        true,
      );
      return;
    }
    if (event.type === "operation.updated") {
      if (isExecutionOperation(event.operation)) {
        const key = this.operationKey(event.threadId, event.turnId, event.operation.itemId);
        const turn = turnKey(event.threadId, event.turnId);
        if (event.operation.status === "running") {
          if (this.pendingApprovalOperations.has(key)) return;
          this.activeOperations.add(key);
          this.reasoningGenerations.set(turn, (this.reasoningGenerations.get(turn) ?? 0) + 1);
        } else {
          this.activeOperations.delete(key);
        }
      }
      const imagePath = event.operation.imagePath;
      if (
        event.operation.kind === "imageGeneration"
        && event.operation.status === "completed"
        && imagePath !== undefined
      ) {
        this.enqueueImage(
          event.target,
          imagePath,
          true,
        );
      }
      if (
        !shouldDisplayOperation(
          event.operation,
          this.options.operationUpdateDisplay ?? "full",
        )
      ) {
        return;
      }
      // 操作只发送终态卡片；运行中状态由审批/执行链路内部维护，避免
      // 同一命令产生“运行中”和“已完成”两条刷屏消息。
      if (event.operation.status === "running") {
        return;
      }
      if (
        this.operationUpdates.accept(event, event.target)
      ) {
        return;
      }
      const rendered = formatWeixinOperation(
        event.operation,
        this.options.operationUpdateDisplay === "compact"
          ? "compact"
          : "full",
      );
      this.enqueueText(event.target, rendered, true);
      return;
    }
    if (event.type === "plan.updated") {
      if (!this.options.planUpdatesEnabled) {
        return;
      }
      for (const presentation of this.planProgress.accept(event)) {
        this.enqueueText(
          event.target,
          formatWeixinCommandText(presentation.text, { structuredFields: true }),
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
        this.planProgress.complete(event);
      }
      this.flushOperationUpdates(event.target, event);
    }
    const rendered = await this.render(event);
    if (rendered === null) {
      return;
    }
    const context = this.contexts.get(event.target);
    this.delivery.enqueue(
      event.target.conversationId,
      (signal) => this.sendEvent(event, rendered, signal, context),
      isCriticalOutputEvent(event),
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
    const context = this.contexts.get(target);
    return this.delivery.runOrdered(
      target.conversationId,
      (signal) => this.send(target, text, maximumChunks, signal, context),
    );
  }

  deliverTextSequence(
    target: ConversationTarget,
    texts: readonly string[],
  ): Promise<void> {
    if (this.closed || !this.matches(target)) {
      return Promise.reject(new Error("微信输出目标无效或队列已关闭"));
    }
    const context = this.contexts.get(target);
    return this.delivery.runOrdered(
      target.conversationId,
      async (signal) => {
        for (const text of texts) {
          await this.send(target, text, maximumChunks, signal, context);
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
    this.activeOperations.clear();
    this.reasoningGenerations.clear();
    this.reasoningDisplayedGenerations.clear();
    this.planProgress.clear();
    this.contexts.clear();
  }

  private flushOperationUpdates(
    target: ConversationTarget,
    event: Extract<OutputEvent, { type: "text.completed" | "turn.completed" }>,
  ): void {
    const buffered = this.operationUpdates.flush(event);
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
    this.enqueueText(target, text, true);
  }

  private async render(event: OutputEvent): Promise<string | null> {
    switch (event.type) {
      case "user.message":
        return formatCliInput(event.text);
      case "text.completed":
        if (event.phase === "commentary") {
          return null;
        }
        return event.text.trim().length === 0
          ? emptyCodexResponseText
          : formatWeixinFinalText(
              `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`,
            );
      case "turn.completed": {
        const remainingUsage = event.model && this.options.remainingUsage
          ? (await this.options.remainingUsage?.(
              event.model,
              event.timing?.modelRequestStartedAtMs,
              event.modelProvider,
            )) ?? null
          : null;
        return formatWeixinCommandText(
          renderWeixinTurnCompleted(
            event,
            this.options.priceCurrency,
            this.options.exchangeRate?.() ?? null,
            this.options.debugEnabled ?? false,
            remainingUsage,
          ),
          { structuredFields: true },
        );
      }
      case "connection.lost":
        return formatConnectionLost(visibleUpstreamMessage(event.message));
      case "connection.restored":
        return formatConnectionRestored(visibleUpstreamMessage(event.message));
      case "thread.availability":
        return formatThreadAvailability(
          event.availability,
          event.threadId,
          event.background,
        );
      case "thread.name":
        return formatWeixinCommandText(
          `Session 名称已更新：${event.name ?? "未命名"}`,
          { structuredFields: true },
        );
      case "warning":
        return formatCodexWarning(visibleUpstreamMessage(event.message));
      case "account.updated":
        return formatWeixinCommandText(
          formatRuntimeAccountUpdate(event.authMode, event.planType),
          { structuredFields: true },
        );
      case "account.rateLimits.updated":
        return formatWeixinCommandText(
          formatRuntimeRateLimitUpdate(event.rateLimits),
          { structuredFields: true },
        );
      case "mcp.status.updated":
        return formatWeixinCommandText(
          formatRuntimeMcpStatusUpdate(event),
          { structuredFields: true },
        );
      case "mcp.oauth.completed":
        return formatWeixinCommandText(
          formatRuntimeMcpOAuthCompleted(event),
          { structuredFields: true },
        );
      case "plan.updated":
        return null;
      case "subagent.spawned":
        return formatWeixinCommandText(
          renderPlainLifecyclePresentation(
            createSubagentStartedPresentation(event),
          ),
          { structuredFields: true },
        );
      case "subagent.contacted":
        return formatWeixinCommandText(
          renderPlainLifecyclePresentation(
            createSubagentContactedPresentation(event),
          ),
          { structuredFields: true },
        );
      case "subagent.completed":
        return formatWeixinCommandText(
          renderWeixinSubagentCompleted(
            event,
            this.options.priceCurrency,
            this.options.exchangeRate?.() ?? null,
            this.options.debugEnabled ?? false,
          ),
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
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
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
        contextToken: context.contextToken,
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
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
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
          contextToken: context.contextToken,
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
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
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
      contextToken: context.contextToken,
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
    const context = this.contexts.get(target);
    return this.delivery.runOrdered(
      target.conversationId,
      (signal) => this.sendImage(target, imagePath, signal, context),
    );
  }

  private async invalidateContext(
    target: ConversationTarget,
    expectedContextToken: string,
  ): Promise<void> {
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
    const context = this.contexts.get(target);
    return this.delivery.enqueue(
      target.conversationId,
      (signal) => this.send(target, text, maximumChunks, signal, context),
      critical,
    );
  }

  private enqueueImage(
    target: ConversationTarget,
    imagePath: string,
    critical: boolean,
  ): boolean {
    const context = this.contexts.get(target);
    return this.delivery.enqueue(
      target.conversationId,
      (signal) => this.sendImage(target, imagePath, signal, context),
      critical,
    );
  }

  private matches(target: ConversationTarget): boolean {
    return target.surface === "weixin"
      && target.accountId === this.accountId;
  }

  private clearExecutionTurns(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of this.activeOperations) {
      if (key.startsWith(prefix)) this.activeOperations.delete(key);
    }
    for (const key of this.reasoningGenerations.keys()) {
      if (key.startsWith(prefix)) this.reasoningGenerations.delete(key);
    }
    for (const key of this.reasoningDisplayedGenerations.keys()) {
      if (key.startsWith(prefix)) this.reasoningDisplayedGenerations.delete(key);
    }
  }

  private operationKey(threadId: string, turnId: string, itemId: string): string {
    return `${turnKey(threadId, turnId)}\u0000${itemId}`;
  }

  prepareInteraction(request: InteractionRequest): void {
    if (request.type === "approval") {
      this.pendingApprovalOperations.add(this.operationKey(request.threadId, request.turnId, request.itemId));
    }
  }

  finishInteraction(request: InteractionRequest, decision: InteractionDecision): void {
    void decision;
    if (request.type === "approval") {
      this.pendingApprovalOperations.delete(this.operationKey(request.threadId, request.turnId, request.itemId));
    }
  }

  private hasActiveOperation(threadId: string, turnId: string): boolean {
    const prefix = `${turnKey(threadId, turnId)}\u0000`;
    return [...this.activeOperations].some((key) => key.startsWith(prefix));
  }

}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
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
