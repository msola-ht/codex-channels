import { GrammyError, InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup, InputRichMessage } from "grammy/types";
import type { Logger } from "pino";

import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";
import {
  type MessagePhase,
  type OperationUpdate,
  type OutputEvent,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { readGeneratedImage } from "../generated-image.js";
import {
  OperationUpdateBuffer,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";
import { isExecutionOperation, shouldDisplayOperation } from "../operation-presentation.js";
import { TurnReplyTargets } from "../turn-reply-targets.js";
import {
  createSubagentContactedPresentation,
  createSubagentStartedPresentation,
  createTurnCompletedPresentation,
  createTurnReasoningPresentation,
  createTurnStartedPresentation,
} from "../lifecycle-presentation.js";
import type {
} from "../../application/index.js";
import {
  cliInputTitle,
  contentTruncatedText,
  emptyCodexResponseText,
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
import type { OperationUpdateDisplay } from "../types.js";
import { TelegramApiExecutor, isTelegramDeliveryUncertain } from "./api-executor.js";
import { TelegramApprovalOperationCoordinator } from "./approval-operation-coordinator.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import { telegramDefaultAccountId } from "./constants.js";
import {
  formatIdleReleaseNotification,
  renderTelegramLifecyclePresentation,
  renderTelegramSubagentCompleted,
  splitTelegramText,
} from "./format.js";
import {
  decodeMarkdownBackslashEscapes,
  formatMarkdownAsTelegramHtml,
  telegramFormattedHtmlText,
} from "./markdown-format.js";
import { formatTelegramPanelChunks, hasTelegramReplyHeading } from "./html-format.js";
import {
  planLongFinalMessage,
  splitExpandableMessage,
  type LongFinalMessagePlan,
} from "./long-message-format.js";
import {
  formatOperationLog,
  formatTelegramOperationSummary,
} from "./operation-format.js";
import { TelegramTypingIndicator } from "./typing-indicator.js";

interface StreamState {
  refreshQueued?: boolean;
  deliveredPlainText?: string;
  deliveryUncertain?: boolean;
  chatId: string;
  turnKey: string;
  text: string;
  messageId: number | undefined;
  phase: MessagePhase | null | undefined;
  completed: boolean;
  truncated: boolean;
  timer: NodeJS.Timeout | undefined;
}

interface OperationLogState {
  chatId: string;
  turnKey: string;
  order: string[];
  records: Map<string, OperationUpdate>;
  messageIds: Map<string, number>;
  deliveredText: Map<string, string>;
  uncertainItems: Set<string>;
  queuedItems: Set<string>;
  final: boolean;
  timer: NodeJS.Timeout | undefined;
}

interface TelegramReasoningMessage {
  refreshQueued?: boolean;
  deliveredText?: string;
  deliveryUncertain?: boolean;
  final?: boolean;
  generation: number;
  chatId: string;
  threadId: string;
  turnId: string;
  text: string;
  sealed: boolean;
  messageId?: number | undefined;
}

const maximumRichMarkdownCharacters = 32_000;
const maximumTelegramActiveStreams = 100;
const maximumTelegramBufferedStreamCharacters = 1_000_000;
const telegramStreamTruncationMarker = `\n\n（${contentTruncatedText}）`;

export type TelegramFinalMessageFormat = "html" | "rich";

export interface TelegramOutboxOptions {
  finalMessageFormat?: TelegramFinalMessageFormat;
  accountId?: string;
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  reasoningEnabled?: boolean;
  readGeneratedImage?: typeof readGeneratedImage;
  autoCompactPercent?: (
    provider: string | null | undefined,
    model: string | null | undefined,
  ) => number | null;
  debugEnabled?: boolean;
}

export class TelegramOutbox {
  private readonly streams = new Map<string, StreamState>();
  private readonly operationLogs = new Map<string, OperationLogState>();
  private readonly uncertainOperationItems = new Map<string, Set<string>>();
  private readonly operationUpdates = new OperationUpdateBuffer<string>();
  private readonly planProgress = new TurnPlanProgressState();
  private readonly reasoningMessages = new Map<string, TelegramReasoningMessage>();
  private readonly activeOperations = new Set<string>();
  private readonly reasoningGenerations = new Map<string, number>();
  private readonly replyTargets = new TurnReplyTargets<number>();
  private readonly typing: TelegramTypingIndicator;
  private readonly delivery: ConversationDeliveryQueue;
  private readonly approvalOperations = new TelegramApprovalOperationCoordinator();
  private readonly notifiedTurns = new Set<string>();
  private streamCapacityWarningIssued = false;
  private closed = false;
  private confirmingDelivery = false;

  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
    private readonly executor = new TelegramApiExecutor(logger),
    private readonly options: TelegramOutboxOptions = {},
  ) {
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Telegram",
      drainOnClose: true,
      operationTimeoutMs: 120_000,
      errorMetadata: (error) => ({ ...telegramErrorMetadata(error) }),
    });
    this.typing = new TelegramTypingIndicator((chatId, isCurrent) => this.enqueueTyping(chatId, isCurrent));
  }

  prepareTurnReplyTarget(conversationId: string, messageId: number): void {
    if (!this.closed) {
      this.replyTargets.prepare(conversationId, messageId);
    }
  }

  discardPendingTurnReplyTarget(conversationId: string): void {
    this.replyTargets.discardPending(conversationId);
  }

  bindPendingTurnReplyTarget(
    conversationId: string,
    threadId: string,
    turnId: string,
  ): void {
    if (!this.closed) {
      this.replyTargets.bindPending(
        conversationId,
        this.turnKey(threadId, turnId),
      );
    }
  }

  setTurnReplyTarget(threadId: string, turnId: string, messageId: number): void {
    if (this.closed) {
      return;
    }
    this.replyTargets.set(this.turnKey(threadId, turnId), messageId);
  }

  trackInput(conversationId: string, handle: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("渠道输出已关闭"));
    return this.delivery.track(conversationId, handle);
  }

  deliver(event: OutputEvent): Promise<void> {
    if (this.closed) return Promise.reject(new Error("渠道输出已关闭"));
    return this.delivery.track(event.target.conversationId, () => {
      this.confirmingDelivery = true;
      try { this.handle(event); } finally { this.confirmingDelivery = false; }
      if (event.type === "operation.updated") {
        const key = this.turnKey(event.threadId, event.turnId);
        this.delivery.enqueue(event.target.conversationId, () => {
          if (this.uncertainOperationItems.get(key)?.has(event.operation.itemId)) return Promise.reject(new Error("操作消息投递结果待核对"));
          return Promise.resolve();
        }, true);
      }
    });
  }

  handle(event: OutputEvent): void {
    if (
      this.closed
      || event.target.surface !== "telegram"
      || event.target.accountId !== (this.options.accountId ?? telegramDefaultAccountId)
    ) {
      return;
    }
    const chatId = event.target.conversationId;
    switch (event.type) {
      case "turn.started":
        this.clearExecutionTurns(event.threadId);
        this.reasoningMessages.delete(event.threadId);
        this.replyTargets.bindPending(
          chatId,
          this.turnKey(event.threadId, event.turnId),
        );
        this.typing.start(chatId, this.turnActivityKey(event.threadId, event.turnId));
        this.enqueue(
          chatId,
          async (signal) => {
            await this.sendPanel(
              chatId,
              renderTelegramLifecyclePresentation(
                createTurnStartedPresentation(
                  event.background ? event.threadId : undefined,
                  event.identity,
                ),
              ),
              this.replyTargets.get(this.turnKey(event.threadId, event.turnId)),
              true,
              signal,
            );
          },
          true,
        );
        return;
      case "turn.reasoning":
        if (this.options.reasoningEnabled === false) {
          return;
        }
        if (this.hasActiveOperation(event.threadId, event.turnId)) {
          return;
        }
        this.deliverReasoning(
          event,
          this.reasoningGenerations.get(this.turnKey(event.threadId, event.turnId)) ?? 0,
        );
        return;
      case "user.message": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.enqueue(chatId, async (signal) => {
          const messageId = await this.sendPanel(
            chatId,
            formatTelegramCliInput(event.text),
            undefined,
            true,
            signal,
          );
          if (messageId !== undefined) {
            this.replyTargets.set(turnKey, messageId);
          }
        }, true);
        return;
      }
      case "text.delta": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const key = this.streamKey(turnKey, event.itemId);
        const existing = this.streams.get(key);
        if (!existing && this.streams.size >= maximumTelegramActiveStreams) {
          if (!this.streamCapacityWarningIssued) {
            this.streamCapacityWarningIssued = true;
            this.logger.warn(
              {
                component: "Telegram",
                maximumActiveStreams: maximumTelegramActiveStreams,
              },
              "Telegram 活动流状态已满，当前非关键增量未接收",
            );
          }
          return;
        }
        if (this.streams.size < maximumTelegramActiveStreams) {
          this.streamCapacityWarningIssued = false;
        }
        if (!existing) {
          this.sealOperationLog(chatId, turnKey);
        }
        const state = existing ?? this.createStream(chatId, turnKey);
        const bounded = boundedTelegramStreamText(`${state.text}${event.text}`);
        state.text = bounded.text;
        state.truncated ||= bounded.truncated;
        if (event.phase !== undefined) {
          state.phase = event.phase;
        }
        this.streams.set(key, state);
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = undefined;
            if (state.refreshQueued) return;
            state.refreshQueued = true;
            if (!this.enqueue(chatId, async signal => {
              state.refreshQueued = false;
              await this.flush(chatId, key, false, undefined, signal);
            }, true)) state.refreshQueued = false;
          }, 1_000);
          state.timer.unref();
        }
        return;
      }
      case "text.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.flushOperationUpdates(chatId, event);
        this.sealOperationLog(chatId, turnKey);
        const key = this.streamKey(turnKey, event.itemId);
        const existing = this.streams.get(key);
        const state = existing ?? this.createStream(chatId, turnKey);
        const bounded = boundedTelegramStreamText(
          `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`,
        );
        state.text = bounded.text;
        state.truncated = bounded.truncated;
        state.completed = true;
        if (event.phase !== undefined) {
          state.phase = event.phase;
        }
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        if (existing) {
          this.streams.set(key, state);
        }
        this.enqueue(
          chatId,
          (signal) => this.flush(chatId, key, true, existing ? undefined : state, signal),
          true,
        );
        return;
      }
      case "operation.updated": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        if (isExecutionOperation(event.operation)) {
          const operationKey = this.operationKey(turnKey, event.operation.itemId);
          if (event.operation.status === "running") {
            this.activeOperations.add(operationKey);
            this.reasoningGenerations.set(turnKey, (this.reasoningGenerations.get(turnKey) ?? 0) + 1);
          } else {
            this.activeOperations.delete(operationKey);
          }
          if (event.operation.status === "running") {
            this.sealReasoningMessage(event.threadId, event.turnId);
          }
        }
        let streamFlushed = false;
        const flushStreamBeforeOutput = (): void => {
          if (streamFlushed) {
            return;
          }
          streamFlushed = true;
          this.flushStreamsBeforeVisibleOutput(chatId, turnKey);
        };
        const imagePath = event.operation.imagePath;
        if (
          event.operation.kind === "imageGeneration"
          && event.operation.status === "completed"
          && imagePath !== undefined
        ) {
          flushStreamBeforeOutput();
          this.enqueue(
            chatId,
            (signal) => this.sendImage(chatId, imagePath, signal),
            true,
          );
        }
        if (!shouldDisplayOperation(
          event.operation,
          this.options.operationUpdateDisplay ?? "full",
        )) {
          return;
        }
        const operationKey = this.operationKey(turnKey, event.operation.itemId);
        const disposition = this.approvalOperations.routeOperation(operationKey, {
          chatId,
          turnKey,
          operation: event.operation,
        });
        if (disposition === "suppress") {
          return;
        }
        if (disposition === "hold") {
          return;
        }
        flushStreamBeforeOutput();
        if (!this.confirmingDelivery && this.operationUpdates.accept(event, chatId)) {
          return;
        }
        const state = this.operationLogs.get(turnKey) ?? this.createOperationLog(chatId, turnKey);
        if (!state.records.has(event.operation.itemId)) {
          state.order.push(event.operation.itemId);
          if (state.order.length > 100) {
            const removed = state.order.shift();
            if (removed) {
              state.records.delete(removed);
              state.deliveredText.delete(removed);
            }
          }
        }
        state.records.set(event.operation.itemId, event.operation);
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = undefined;
            this.enqueueOperationRefresh(state);
          }, 750);
          state.timer.unref();
        }
        this.operationLogs.set(turnKey, state);
        if (this.confirmingDelivery) {
          if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
          this.enqueueOperationRefresh(state, true);
        }
        return;
      }
      case "plan.updated": {
        if (!this.options.planUpdatesEnabled) {
          return;
        }
        for (const presentation of this.planProgress.accept(event)) {
          this.enqueue(
            chatId,
            (signal) => this.send(
              chatId,
              presentation.text,
              undefined,
              true,
              signal,
            ).then(() => undefined),
            true,
          );
        }
        return;
      }
      case "subagent.spawned":
        this.flushStreamsBeforeVisibleOutput(
          chatId,
          this.turnKey(event.threadId, event.turnId),
        );
        this.enqueue(
          chatId,
          (signal) => this.sendPanel(
            chatId,
            renderTelegramLifecyclePresentation(
              createSubagentStartedPresentation(event),
            ),
            undefined,
            true,
            signal,
          ).then(() => undefined),
          false,
        );
        return;
      case "subagent.contacted":
        this.flushStreamsBeforeVisibleOutput(
          chatId,
          this.turnKey(event.threadId, event.turnId),
        );
        this.enqueue(
          chatId,
          (signal) => this.sendPanel(
            chatId,
            renderTelegramLifecyclePresentation(
              createSubagentContactedPresentation(event),
            ),
            undefined,
            true,
            signal,
          ).then(() => undefined),
          false,
        );
        return;
      case "subagent.completed":
        this.enqueue(
          chatId,
          (signal) => this.sendPanel(
            chatId,
            renderTelegramSubagentCompleted(
              event,
              this.options.debugEnabled ?? false,
            ),
            undefined,
            true,
            signal,
          ).then(() => undefined),
          false,
        );
        return;
      case "turn.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.planProgress.complete(event);
        this.flushOperationUpdates(chatId, event);
        this.sealOperationLog(chatId, turnKey);
        // Queued batches retain their shared Set until delivery ends.
        this.uncertainOperationItems.delete(turnKey);
        const keys = this.streamKeysForTurn(event.threadId, event.turnId);
        for (const key of keys) {
          const stream = this.streams.get(key);
          if (stream?.timer) {
            clearTimeout(stream.timer);
            stream.timer = undefined;
          }
        }
        this.typing.stop(chatId, this.turnActivityKey(event.threadId, event.turnId));
        this.enqueue(chatId, async (signal) => {
          for (const key of keys) {
            await this.flush(chatId, key, true, undefined, signal);
          }
          const replyTo = this.replyTargets.get(turnKey);
          try {
            await this.sendPanel(
              chatId,
              renderTelegramLifecyclePresentation(
                createTurnCompletedPresentation(
                  event,
                  this.options.debugEnabled ?? false,
                  this.options.autoCompactPercent,
                ),
              ),
              replyTo,
              true,
              signal,
            );
          } finally {
            this.replyTargets.delete(turnKey);
            this.notifiedTurns.delete(turnKey);
            this.clearApprovalOperationsForTurn(turnKey);
          }
        }, true);
        return;
      }
      case "warning":
        this.enqueue(chatId, async (signal) => {
          await this.send(
            chatId,
            formatCodexWarning(visibleUpstreamMessage(event.message)),
            undefined,
            true,
            signal,
          );
        }, true);
        return;
      case "conversation.idle.released":
        this.enqueue(chatId, async (signal) => {
          await this.sendPanel(
            chatId,
            formatIdleReleaseNotification(event.minutes, event.threadId),
            undefined,
            true,
            signal,
          );
        }, true);
        return;
      case "thread.availability":
        this.enqueue(chatId, async (signal) => {
          await this.send(
            chatId,
            formatThreadAvailability(
              event.availability,
              event.threadId,
              event.background,
            ),
            undefined,
            true,
            signal,
          );
        }, true);
        return;
      case "connection.lost":
        this.clearThreadOutput(chatId, event.threadId);
        this.enqueue(chatId, async (signal) => {
          await this.send(chatId, formatConnectionLost(event.message), undefined, false, signal);
        }, true);
        return;
      case "connection.restored":
        this.enqueue(chatId, async (signal) => {
          await this.send(chatId, formatConnectionRestored(event.message), undefined, false, signal);
        }, true);
        return;
      case "account.updated":
        this.enqueue(chatId, async (signal) => {
          await this.sendPanel(
            chatId,
            formatRuntimeAccountUpdate(event.authMode, event.planType),
            undefined,
            true,
            signal,
          );
        }, true);
        return;
      case "account.rateLimits.updated":
        this.enqueue(chatId, async (signal) => {
          await this.sendPanel(
            chatId,
            formatRuntimeRateLimitUpdate(event.rateLimits),
            undefined,
            true,
            signal,
          );
        }, true);
        return;
      case "mcp.status.updated":
        this.enqueue(chatId, async (signal) => {
          await this.sendPanel(
            chatId,
            formatRuntimeMcpStatusUpdate(event),
            undefined,
            event.status !== "failed",
            signal,
          );
        }, event.status === "failed");
        return;
      case "mcp.oauth.completed":
        this.enqueue(chatId, async (signal) => {
          await this.sendPanel(
            chatId,
            formatRuntimeMcpOAuthCompleted(event),
            undefined,
            event.success,
            signal,
          );
        }, true);
        return;
      case "thread.status":
        return;
      case "thread.name":
        this.enqueue(chatId, async (signal) => { await this.sendPanel(
          chatId,
          `Session 名称已更新：${event.name ?? "未命名"}`,
          undefined,
          true,
          signal,
        ); }, true);
        return;
    }
  }

  private async sendImage(
    chatId: string,
    imagePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const image = await (
      this.options.readGeneratedImage ?? readGeneratedImage
    )(imagePath);
    await this.executor.call(
      {
        chatId,
        operation: "sendPhoto",
        critical: false,
      },
      (requestSignal) => this.api.sendPhoto(
        chatId,
        new InputFile(
          image.bytes,
          `codex-generated-image.${image.format === "jpeg" ? "jpg" : "png"}`,
        ),
        { disable_notification: true },
        requestSignal as never,
      ),
      signal,
    );
  }

  sendChannelImage(chatId: string, imagePath: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.sendImage(chatId, imagePath, signal),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { target, summary } of this.operationUpdates.drain()) {
      this.enqueueOperationSummary(target, summary);
    }
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.completed) {
        this.enqueue(state.chatId, (signal) => this.flush(state.chatId, key, true, undefined, signal), true);
      }
    }
    for (const [key, state] of this.operationLogs) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if ([...state.records.values()].every((record) => record.status !== "running")) {
        this.operationLogs.delete(key);
        this.enqueueOperationRefresh(state, true);
      }
    }
    this.typing.close();
    await this.delivery.close();
    this.streams.clear();
    this.operationLogs.clear();
    this.operationUpdates.clear();
    this.planProgress.clear();
    this.reasoningMessages.clear();
    this.activeOperations.clear();
    this.uncertainOperationItems.clear();
    this.reasoningGenerations.clear();
    this.replyTargets.clear();
    this.approvalOperations.clear();
    this.notifiedTurns.clear();
  }

  showTyping(chatId: string): void {
    this.typing.show(chatId);
  }

  beginTyping(chatId: string): () => void {
    return this.typing.begin(chatId);
  }

  prepareInteraction(chatId: string, request: InteractionRequest): void {
    if (this.closed) {
      return;
    }
    this.holdApprovalOperation(chatId, request);
    for (const [turnKey, state] of this.operationLogs) {
      if (state.chatId === chatId) {
        this.sealOperationLogBeforeInteraction(chatId, turnKey, state);
      }
    }
    for (const [key, state] of this.streams) {
      if (state.chatId !== chatId || !state.text.trim()) {
        continue;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      this.enqueue(chatId, (signal) => this.flush(chatId, key, state.completed, undefined, signal), true);
    }
  }

  finishInteraction(
    _chatId: string,
    request: InteractionRequest,
    decision: InteractionDecision,
  ): void {
    if (this.closed || request.type !== "approval") {
      return;
    }
    const resolution = this.approvalOperations.finish(request, decision);
    if (!resolution) {
      return;
    }
    const turnKey = this.turnKey(request.threadId, request.turnId);
    let state = this.operationLogs.get(turnKey);
    if (resolution.rejected) {
      this.removeOperationFromLog(turnKey, request.itemId, state);
    }
    if (resolution.pending || resolution.suppressed) {
      return;
    }
    const held = resolution.held;
    if (held) {
      state = this.operationLogs.get(turnKey) ?? this.createOperationLog(held.chatId, turnKey);
      if (!state.records.has(request.itemId)) {
        state.order.push(request.itemId);
      }
      state.records.set(request.itemId, held.operation);
      this.operationLogs.set(turnKey, state);
    }
    if (state?.records.has(request.itemId)) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      this.enqueueOperationRefresh(state);
    }
  }

  runOrdered<T>(chatId: string, run: (signal: AbortSignal) => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Telegram Outbox 已关闭"));
    }
    return this.delivery.runOrdered(chatId, run, requestSignal);
  }

  notifyPanel(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): boolean {
    return this.enqueue(chatId, (signal) => this.sendNotificationPanel(chatId, text, replyMarkup, signal), true);
  }

  deliverPanel(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    return this.runOrdered(chatId, (signal) => this.sendNotificationPanel(chatId, text, replyMarkup, signal));
  }

  private enqueue(
    chatId: string,
    run: (signal: AbortSignal) => Promise<void>,
    critical: boolean,
  ): boolean {
    return this.delivery.enqueue(chatId, run, critical);
  }

  private async sendNotificationPanel(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    signal?: AbortSignal,
  ): Promise<void> {
    const chunks = formatTelegramPanelChunks(text);
    for (const [index, chunk] of chunks.entries()) {
      const finalChunk = index === chunks.length - 1;
      await this.executor.call(
        { chatId, operation: "sendMessage", critical: true },
        (requestSignal) => this.api.sendMessage(chatId, chunk, {
          ...htmlSendOptions(undefined, index > 0),
          ...(finalChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }, requestSignal as never),
        signal,
      );
    }
  }

  private async flush(
    chatId: string, key: string, final: boolean, standaloneState?: StreamState, signal?: AbortSignal,
  ): Promise<void> {
    const state = standaloneState ?? this.streams.get(key);
    if (!state) return;
    try {
      signal?.throwIfAborted();
      if (state.deliveryUncertain) {
        if (final) throw new Error("流式消息投递结果待核对");
        return;
      }
      await this.flushStream(chatId, key, final, standaloneState, signal);
    } catch (error) {
      if (state.messageId === undefined && isTelegramDeliveryUncertain(error)) state.deliveryUncertain = true;
      throw error;
    } finally {
      if (final && !standaloneState) this.streams.delete(key);
    }
  }

  private async flushStream(
    chatId: string,
    key: string,
    final: boolean,
    standaloneState?: StreamState,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = standaloneState ?? this.streams.get(key);
    if (!state || (!final && state.completed)) {
      return;
    }
    if (!state.text.trim()) {
      if (!final || state.phase === "commentary") {
        if (final && !standaloneState) {
          this.streams.delete(key);
        }
        return;
      }
      state.text = emptyCodexResponseText;
    }
    const text = state.text.trimEnd();
    if (final && state.phase !== "commentary") {
      const longMessage = planLongFinalMessage(text);
      if (longMessage) {
        try {
          state.messageId = await this.sendLongFinal(chatId, state, text, longMessage, signal);
          if (!standaloneState) {
            this.streams.delete(key);
          }
          return;
        } catch (error) {
          if (longMessage.kind === "html" || !canFallbackTelegramFormat(error)) throw error;
          this.logger.warn(
            { chatId, ...telegramErrorMetadata(error) },
            "Telegram 长回复优化发送失败，回退普通文本",
          );
        }
      }
      {
        // Native Rich Markdown must not recreate the reserved interaction heading.
        const reservedHeading = hasTelegramReplyHeading(formatMarkdownAsTelegramHtml(text.split("\n", 1)[0]!) ?? "");
        const format = reservedHeading ? "html" : this.options.finalMessageFormat ?? "html";
        const formatted = format === "rich"
          ? canSendRichMarkdown(text) ? text : undefined
          : formatMarkdownAsTelegramHtml(text);
        if (formatted !== undefined) {
          try {
            state.messageId = format === "rich"
              ? await this.sendRichFinal(chatId, state, formatted, signal)
              : await this.sendHtmlFinal(chatId, state, formatted, signal);
            if (!standaloneState) {
              this.streams.delete(key);
            }
            return;
          } catch (error) {
            if (state.messageId !== undefined && isMessageNotModified(error)) {
              if (!standaloneState) this.streams.delete(key);
              return;
            }
            if (!canFallbackTelegramFormat(error)) throw error;
            this.logger.warn(
              {
                chatId,
                format,
                ...telegramErrorMetadata(error),
              },
              "Telegram 格式化消息渲染失败，回退纯文本",
            );
          }
        }
      }
    }
    const [first, ...rest] = splitTelegramText(text);
    if (!first) {
      return;
    }
    if (state.messageId && state.deliveredPlainText !== first) {
      try {
        await this.executor.call(
          { chatId, operation: "editMessageText", critical: final },
          (requestSignal) => this.api.editMessageText(chatId, state.messageId!, first, undefined, requestSignal as never),
          signal,
        );
      } catch (error) {
        if (isMessageNotModified(error)) {
          // The authoritative final text is already visible.
        } else if (final && canFallbackTelegramFormat(error)) {
          state.messageId = await this.sendFirstChunk(chatId, state, first, signal, final);
        } else {
          throw error;
        }
      }
    } else if (!state.messageId) {
      state.messageId = await this.sendFirstChunk(chatId, state, first, signal, final);
    }
    state.deliveredPlainText = first;
    if (final) {
      for (const chunk of rest) {
        await this.sendMessage(chatId, chunk, undefined, true, signal);
      }
      if (!standaloneState) {
        this.streams.delete(key);
      }
    }
  }

  private createStream(chatId: string, turnKey: string): StreamState {
    return {
      chatId,
      turnKey,
      text: "",
      messageId: undefined,
      phase: undefined,
      completed: false,
      truncated: false,
      timer: undefined,
    };
  }

  private createOperationLog(chatId: string, turnKey: string): OperationLogState {
    const uncertainItems = this.uncertainOperationItems.get(turnKey) ?? new Set<string>();
    this.uncertainOperationItems.set(turnKey, uncertainItems);
    return {
      chatId,
      turnKey,
      order: [],
      records: new Map(),
      messageIds: new Map(),
      deliveredText: new Map(),
      uncertainItems,
      queuedItems: new Set(),
      final: false,
      timer: undefined,
    };
  }

  private holdApprovalOperation(chatId: string, request: InteractionRequest): void {
    if (request.type !== "approval") {
      return;
    }
    const turnKey = this.turnKey(request.threadId, request.turnId);
    const state = this.operationLogs.get(turnKey);
    const operation = state?.chatId === chatId
      ? state.records.get(request.itemId)
      : undefined;
    this.approvalOperations.prepare(
      request,
      operation ? { chatId, turnKey, operation } : undefined,
    );
    if (state?.chatId === chatId) {
      if (operation) {
        state.records.delete(request.itemId);
        state.order = state.order.filter((itemId) => itemId !== request.itemId);
        const messageId = state.messageIds.get(request.itemId);
        if (messageId !== undefined) {
          state.messageIds.delete(request.itemId);
          this.enqueue(
            chatId,
            (signal) => this.executor.call(
              { chatId, operation: "deleteMessage", critical: true },
              (requestSignal) => this.api.deleteMessage(
                chatId,
                messageId,
                requestSignal as never,
              ),
              signal,
            ).then(() => undefined),
            true,
          );
        }
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.records.size === 0 && state.messageIds.size === 0) {
        this.operationLogs.delete(turnKey);
      }
    }
  }

  private sealOperationLogBeforeInteraction(
    _chatId: string,
    turnKey: string,
    state: OperationLogState,
  ): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.operationLogs.delete(turnKey);
    this.enqueueOperationRefresh(state, true);
  }

  private removeOperationFromLog(
    turnKey: string,
    itemId: string,
    state: OperationLogState | undefined,
  ): void {
    if (!state) {
      return;
    }
    state.records.delete(itemId);
    state.deliveredText.delete(itemId);
    state.order = state.order.filter((candidate) => candidate !== itemId);
    const messageId = state.messageIds.get(itemId);
    if (messageId !== undefined) {
      state.messageIds.delete(itemId);
      this.enqueue(
        state.chatId,
        (signal) => this.executor.call(
          { chatId: state.chatId, operation: "deleteMessage", critical: true },
          (requestSignal) => this.api.deleteMessage(
            state.chatId,
            messageId,
            requestSignal as never,
          ),
          signal,
        ).then(() => undefined),
        true,
      );
    }
    if (state.records.size === 0 && state.messageIds.size === 0) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      this.operationLogs.delete(turnKey);
    }
  }

  private sealOperationLog(_chatId: string, turnKey: string): void {
    const state = this.operationLogs.get(turnKey);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.operationLogs.delete(turnKey);
    this.enqueueOperationRefresh(state, true);
  }

  private flushOperationUpdates(
    chatId: string,
    event: Extract<OutputEvent, { type: "text.completed" | "turn.completed" }>,
  ): void {
    const buffered = this.operationUpdates.flush(event);
    if (buffered === null) {
      return;
    }
    this.enqueueOperationSummary(
      chatId,
      buffered.summary,
    );
  }

  private flushStreamsBeforeVisibleOutput(chatId: string, turnKey: string): void {
    for (const [key, state] of this.streams) {
      if (state.turnKey !== turnKey || !state.timer) {
        continue;
      }
      clearTimeout(state.timer);
      state.timer = undefined;
      this.enqueue(chatId, (signal) => this.flush(chatId, key, false, undefined, signal), true);
    }
  }

  private enqueueOperationSummary(
    chatId: string,
    summary: OperationUpdateSummary,
  ): void {
    const text = formatTelegramOperationSummary(
      summary,
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
    );
    this.enqueue(
      chatId,
      async (signal) => {
        await this.sendOperationMessage(
          chatId,
          text,
          undefined,
          signal,
        );
      },
      true,
    );
  }

  private enqueueOperationRefresh(state: OperationLogState, final = false): void {
    state.final ||= final;
    for (const itemId of state.order) {
      const record = state.records.get(itemId);
      if (!record || state.queuedItems.has(itemId) || state.uncertainItems.has(itemId)) continue;
      if (state.messageIds.has(itemId) && state.deliveredText.get(itemId) === this.operationText(record)) continue;
      state.queuedItems.add(itemId);
      // Each message receives its own deadline, in the same Conversation order.
      // Read the latest record when execution starts, including completed Items.
      if (!this.enqueue(state.chatId, async signal => {
        state.queuedItems.delete(itemId);
        const latest = state.records.get(itemId);
        if (latest) await this.flushOperationRecord(state, latest, signal);
      }, true)) state.queuedItems.delete(itemId);
    }
  }

  private operationText(record: OperationUpdate): string {
    return formatOperationLog({ order: [record.itemId], records: new Map([[record.itemId, record]]) },
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full");
  }

  private async flushOperationRecord(state: OperationLogState, record: OperationUpdate, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (state.uncertainItems.has(record.itemId)) return;
    const { chatId, final } = state;
    let creating = !state.messageIds.has(record.itemId);
    try {
      const text = this.operationText(record);
      const messageId = state.messageIds.get(record.itemId);
      if (messageId !== undefined && state.deliveredText.get(record.itemId) === text) return;
      if (messageId === undefined) {
        state.messageIds.set(
          record.itemId,
          await this.sendOperationMessage(chatId, text, undefined, signal, final),
        );
        state.deliveredText.set(record.itemId, text);
        return;
      }
      try {
        await this.executor.call(
          { chatId, operation: "editMessageText", critical: final },
          (requestSignal) => this.api.editMessageText(
            chatId,
            messageId,
            text,
            operationEditOptions(),
            requestSignal as never,
          ),
          signal,
        );
      } catch (error) {
        if (!isMessageNotModified(error)) {
          if (!final || !canFallbackTelegramFormat(error)) {
            throw error;
          }
          creating = true;
          state.messageIds.set(
            record.itemId,
            await this.sendOperationMessage(chatId, text, undefined, signal, final),
          );
        }
      }
      state.deliveredText.set(record.itemId, text);
    } catch (error) {
      if (creating && isTelegramDeliveryUncertain(error)) state.uncertainItems.add(record.itemId);
      this.logger.warn({ chatId, itemId: record.itemId, ...telegramErrorMetadata(error),
        deliveryUncertain: state.uncertainItems.has(record.itemId) }, "Telegram 操作消息投递失败，继续处理其他操作");
      throw error;
    }
  }

  private async send(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of splitTelegramText(text)) {
      const messageId = await this.sendMessage(
        chatId,
        chunk,
        firstMessageId === undefined ? replyTo : undefined,
        silent || firstMessageId !== undefined,
        signal,
      );
      firstMessageId ??= messageId;
    }
    return firstMessageId;
  }

  private async sendPanel(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of formatTelegramPanelChunks(text)) {
      const messageId = await this.sendHtmlMessage(
        chatId,
        chunk,
        firstMessageId === undefined ? replyTo : undefined,
        silent || firstMessageId !== undefined,
        signal,
      );
      firstMessageId ??= messageId;
    }
    return firstMessageId;
  }

  private deliverReasoning(
    event: Extract<OutputEvent, { type: "turn.reasoning" }>,
    generation: number,
  ): void {
    const chatId = event.target.conversationId;
    const text = renderTelegramLifecyclePresentation(
      createTurnReasoningPresentation(
        event.background ? event.threadId : undefined,
        event.elapsedMs,
        event.final === true,
      ),
    );
    let state = this.reasoningMessages.get(event.threadId);
    if (state?.turnId !== event.turnId) state = undefined;
    if (!state) {
      state = { chatId, threadId: event.threadId, turnId: event.turnId, text, sealed: false, generation };
      this.reasoningMessages.set(event.threadId, state);
    }
    state.text = text;
    state.final = event.final === true;
    if (state.final) this.reasoningMessages.delete(event.threadId);
    this.enqueueReasoningRefresh(state);
  }

  private enqueueReasoningRefresh(state: TelegramReasoningMessage): void {
    if (state.refreshQueued || state.deliveryUncertain) return;
    state.refreshQueued = true;
    if (!this.enqueue(state.chatId, async signal => {
      state.refreshQueued = false;
      const stale = (this.reasoningGenerations.get(this.turnKey(state.threadId, state.turnId)) ?? 0) !== state.generation
        || this.hasActiveOperation(state.threadId, state.turnId);
      // An already-created message still needs its boundary seal; an obsolete
      // segment that was never visible must not be created after the tool starts.
      if (state.deliveryUncertain || (stale && !(state.sealed && state.messageId !== undefined))) return;
      const sourceText = state.text;
      const text = formatTelegramPanelChunks(sourceText)[0] ?? sourceText;
      if (state.deliveredText === text) return;
      let creating = state.messageId === undefined;
      try {
        if (creating) {
          state.messageId = await this.sendPanel(state.chatId, sourceText, undefined, false, signal);
        } else {
          try {
            await this.executor.call({ chatId: state.chatId, operation: "editMessageText", critical: state.final === true },
              requestSignal => this.api.editMessageText(state.chatId, state.messageId!, text, operationEditOptions(), requestSignal as never), signal);
          } catch (error) {
            if (!isMessageNotModified(error)) {
              if (!state.final || !canFallbackTelegramFormat(error)) throw error;
              creating = true;
              state.messageId = await this.sendPanel(state.chatId, sourceText, undefined, false, signal);
            }
          }
        }
        state.deliveredText = text;
      } catch (error) {
        if (creating && isTelegramDeliveryUncertain(error)) state.deliveryUncertain = true;
        throw error;
      }
    }, true)) state.refreshQueued = false;
  }

  private sealReasoningMessage(threadId: string, turnId: string): void {
    const state = this.reasoningMessages.get(threadId);
    if (!state || state.turnId !== turnId) return;
    this.reasoningMessages.delete(threadId);
    state.sealed = true;
    state.final = true;
    state.text = state.text.replace("思考中…", "思考完成");
    this.enqueueReasoningRefresh(state);
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private hasActiveOperation(threadId: string, turnId: string): boolean {
    const prefix = `${this.turnKey(threadId, turnId)}:`;
    return [...this.activeOperations].some((key) => key.startsWith(prefix));
  }

  private clearExecutionTurns(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.activeOperations) {
      if (key.startsWith(prefix)) this.activeOperations.delete(key);
    }
    for (const key of this.reasoningGenerations.keys()) {
      if (key.startsWith(prefix)) this.reasoningGenerations.delete(key);
    }
  }

  private streamKey(turnKey: string, itemId: string): string {
    return `${turnKey}:${itemId}`;
  }

  private streamKeysForTurn(threadId: string, turnId: string): string[] {
    const prefix = `${this.turnKey(threadId, turnId)}:`;
    return [...this.streams.keys()].filter((key) => key.startsWith(prefix));
  }

  private turnActivityKey(threadId: string, turnId: string): string {
    return `turn:${this.turnKey(threadId, turnId)}`;
  }

  private operationKey(turnKey: string, itemId: string): string {
    return `${turnKey}:${itemId}`;
  }

  private clearApprovalOperationsForTurn(turnKey: string): void {
    this.approvalOperations.clearTurn(turnKey);
  }

  private async sendFirstChunk(chatId: string, state: StreamState, text: string, signal?: AbortSignal, critical = true): Promise<number> {
    const replyTo = this.replyTargets.get(state.turnKey);
    const silent = state.phase === "commentary" || this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical },
      (requestSignal) => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent), requestSignal as never),
      signal,
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    return message.message_id;
  }

  private async sendRichFinal(
    chatId: string,
    state: StreamState,
    markdown: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const richMessage: InputRichMessage = { markdown };
    if (state.messageId !== undefined) {
      await this.executor.call(
        { chatId, operation: "editMessageText", critical: true },
        (requestSignal) => this.api.editMessageText(chatId, state.messageId!, richMessage, undefined, requestSignal as never),
        signal,
      );
      return state.messageId;
    }

    const replyTo = this.replyTargets.get(state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendRichMessage", critical: true },
      (requestSignal) => this.api.sendRichMessage(
        chatId,
        richMessage,
        richReplyOptions(replyTo, silent),
        requestSignal as never,
      ),
      signal,
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    return message.message_id;
  }

  private async sendHtmlFinal(
    chatId: string,
    state: StreamState,
    html: string,
    signal?: AbortSignal,
  ): Promise<number> {
    if (state.messageId !== undefined) {
      await this.executor.call(
        { chatId, operation: "editMessageText", critical: true },
        (requestSignal) => this.api.editMessageText(chatId, state.messageId!, html, operationEditOptions(), requestSignal as never),
        signal,
      );
      return state.messageId;
    }

    const replyTo = this.replyTargets.get(state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      (requestSignal) => this.api.sendMessage(chatId, html, htmlSendOptions(replyTo, silent), requestSignal as never),
      signal,
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    return message.message_id;
  }

  private async sendLongFinal(
    chatId: string,
    state: StreamState,
    text: string,
    plan: LongFinalMessagePlan,
    signal?: AbortSignal,
  ): Promise<number> {
    if (plan.kind === "html") {
      for (const [index, html] of plan.chunks.entries()) {
        try {
          if (index === 0) state.messageId = await this.sendHtmlFinal(chatId, state, html, signal);
          else await this.sendOperationMessage(chatId, html, undefined, signal);
        } catch (error) {
          if (isMessageNotModified(error) && index === 0 && state.messageId !== undefined) continue;
          if (!canFallbackTelegramFormat(error)) throw error;
          const text = telegramFormattedHtmlText(html);
          if (index === 0 && state.messageId !== undefined) {
            await this.executor.call({ chatId, operation: "editMessageText", critical: true },
              requestSignal => this.api.editMessageText(chatId, state.messageId!, text, undefined, requestSignal as never), signal);
          } else {
            const id = await this.sendFirstChunk(chatId, state, text, signal);
            if (index === 0) state.messageId = id;
          }
        }
      }
      return state.messageId!;
    }
    if (plan.kind === "expandable") {
      return this.sendExpandableFinal(chatId, state, plan.chunks, signal);
    }

    state.messageId = await this.sendHtmlFinal(chatId, state, plan.previewHtml, signal);
    try {
      await this.executor.call(
        { chatId, operation: "sendDocument", critical: true },
        (requestSignal) => this.api.sendDocument(
          chatId,
          new InputFile(plan.content, plan.filename),
          {
            caption: `完整回复 · ${plan.lineCount.toLocaleString("zh-CN")} 行`,
            disable_notification: true,
            reply_parameters: {
              message_id: state.messageId!,
              allow_sending_without_reply: true,
            },
          },
          requestSignal as never,
        ),
        signal,
      );
      return state.messageId;
    } catch (error) {
      if (!canFallbackTelegramFormat(error)) throw error;
      this.logger.warn(
        { chatId, ...telegramErrorMetadata(error) },
        "Telegram 完整回复文件发送失败，回退折叠文本",
      );
      return this.sendExpandableFinal(chatId, state, splitExpandableMessage(text), signal);
    }
  }

  private async sendExpandableFinal(
    chatId: string,
    state: StreamState,
    chunks: readonly string[],
    signal?: AbortSignal,
  ): Promise<number> {
    const first = chunks[0];
    if (!first) {
      throw new Error("Telegram 折叠回复没有可发送内容");
    }

    if (state.messageId !== undefined) {
      await this.executor.call(
        { chatId, operation: "editMessageText", critical: true },
        (requestSignal) => this.api.editMessageText(
          chatId,
          state.messageId!,
          first,
          expandableEditOptions(first),
          requestSignal as never,
        ),
        signal,
      );
    } else {
      const replyTo = this.replyTargets.get(state.turnKey);
      const silent = this.notifiedTurns.has(state.turnKey);
      const message = await this.executor.call(
        { chatId, operation: "sendMessage", critical: true },
        (requestSignal) => this.api.sendMessage(
          chatId,
          first,
          expandableSendOptions(first, replyTo, silent),
          requestSignal as never,
        ),
        signal,
      );
      state.messageId = message.message_id;
      if (!silent) {
        this.notifiedTurns.add(state.turnKey);
      }
    }

    for (const chunk of chunks.slice(1)) {
      await this.executor.call(
        { chatId, operation: "sendMessage", critical: true },
        (requestSignal) => this.api.sendMessage(
          chatId,
          chunk,
          expandableSendOptions(chunk, undefined, true),
          requestSignal as never,
        ),
        signal,
      );
    }
    return state.messageId;
  }

  private async sendMessage(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
    signal?: AbortSignal,
  ): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      (requestSignal) => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent), requestSignal as never),
      signal,
    );
    return message.message_id;
  }

  private async sendHtmlMessage(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
    signal?: AbortSignal,
  ): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      (requestSignal) => this.api.sendMessage(chatId, text, htmlSendOptions(replyTo, silent), requestSignal as never),
      signal,
    );
    return message.message_id;
  }

  private async sendOperationMessage(chatId: string, text: string, replyTo?: number, signal?: AbortSignal, critical = true): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical },
      (requestSignal) => this.api.sendMessage(chatId, text, htmlSendOptions(replyTo, true), requestSignal as never),
      signal,
    );
    return message.message_id;
  }

  private enqueueTyping(chatId: string, isCurrent: () => boolean): void {
    if (this.closed) {
      return;
    }
    this.delivery.enqueueAuxiliary(chatId, async (signal) => {
      if (!isCurrent()) return;
      await this.executor.call(
        { chatId, operation: "sendChatAction", critical: false },
        (requestSignal) => this.api.sendChatAction(chatId, "typing", requestSignal as never),
        signal,
      );
    });
  }

  private clearThreadOutput(chatId: string, threadId: string): void {
    for (const [key, stream] of this.streams) {
      if (stream.turnKey.startsWith(`${threadId}:`)) {
        if (stream.timer) {
          clearTimeout(stream.timer);
        }
        this.streams.delete(key);
      }
    }
    for (const [key, state] of this.operationLogs) {
      if (state.turnKey.startsWith(`${threadId}:`)) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        this.operationLogs.delete(key);
      }
    }
    this.replyTargets.clearThread(threadId);
    const prefix = `${threadId}:`;
    for (const turnKey of this.uncertainOperationItems.keys()) {
      if (turnKey.startsWith(prefix)) this.uncertainOperationItems.delete(turnKey);
    }
    this.approvalOperations.clearThread(threadId);
    for (const turnKey of this.notifiedTurns) {
      if (turnKey.startsWith(prefix)) {
        this.notifiedTurns.delete(turnKey);
      }
    }
    this.typing.clear(chatId);
  }

}

function formatTelegramCliInput(text: string): string {
  const quote = decodeMarkdownBackslashEscapes(text)
    .trim()
    .split("\n")
    .map((line) => `│ ${line}`)
    .join("\n");
  return `${cliInputTitle}\n\n${quote}`;
}

function errorMessageForClassification(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replyOptions(
  replyTo?: number,
  silent = false,
): Parameters<Api["sendMessage"]>[2] {
  return {
    ...(silent ? { disable_notification: true } : {}),
    ...(replyTo === undefined
      ? {}
      : {
          reply_parameters: {
            message_id: replyTo,
            allow_sending_without_reply: true,
          },
        }),
  };
}

function richReplyOptions(
  replyTo?: number,
  silent = false,
): Parameters<Api["sendRichMessage"]>[2] {
  return replyOptions(replyTo, silent);
}

function boundedTelegramStreamText(text: string): {
  text: string;
  truncated: boolean;
} {
  const characters = Array.from(text);
  if (characters.length <= maximumTelegramBufferedStreamCharacters) {
    return { text, truncated: false };
  }
  const marker = Array.from(telegramStreamTruncationMarker);
  return {
    text: characters
      .slice(0, maximumTelegramBufferedStreamCharacters - marker.length)
      .concat(marker)
      .join(""),
    truncated: true,
  };
}

function canSendRichMarkdown(text: string): boolean {
  return Array.from(text).length <= maximumRichMarkdownCharacters;
}

function htmlSendOptions(
  replyTo?: number,
  silent = false,
): Parameters<Api["sendMessage"]>[2] {
  return {
    ...replyOptions(replyTo, silent),
    parse_mode: "HTML",
  };
}

function operationEditOptions(): Parameters<Api["editMessageText"]>[3] {
  return { parse_mode: "HTML" };
}

function expandableSendOptions(
  text: string,
  replyTo?: number,
  silent = false,
): Parameters<Api["sendMessage"]>[2] {
  return {
    ...replyOptions(replyTo, silent),
    entities: [{
      type: "expandable_blockquote",
      offset: 0,
      length: text.length,
    }],
  };
}

function expandableEditOptions(text: string): Parameters<Api["editMessageText"]>[3] {
  return {
    entities: [{
      type: "expandable_blockquote",
      offset: 0,
      length: text.length,
    }],
  };
}

function isMessageNotModified(error: unknown): boolean {
  return errorMessageForClassification(error)
    .toLowerCase()
    .includes("message is not modified");
}

function canFallbackTelegramFormat(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400;
}
