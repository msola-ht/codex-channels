import { InputFile, type Api } from "grammy";
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
import { shouldDisplayOperation } from "../operation-presentation.js";
import { TurnReplyTargets } from "../turn-reply-targets.js";
import {
  createSubagentStartedPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
} from "../lifecycle-presentation.js";
import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
  ProviderModelUsageEstimate,
} from "../../application/index.js";
import {
  formatVisionCompleted,
  formatVisionProgress,
  formatVisionStarted,
} from "../input-copy.js";
import {
  cliInputTitle,
  contentTruncatedText,
  emptyCodexResponseText,
  formatCodexWarning,
  formatConnectionLost,
  formatThreadAvailability,
} from "../output-copy.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpOAuthCompleted,
  formatRuntimeMcpStatusUpdate,
  formatRuntimeRateLimitUpdate,
} from "../runtime-status-format.js";
import { PlanProgressTracker } from "../plan-presentation.js";
import type { OperationUpdateDisplay } from "../types.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { TelegramApprovalOperationCoordinator } from "./approval-operation-coordinator.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import { telegramDefaultAccountId } from "./constants.js";
import {
  renderTelegramLifecyclePresentation,
  renderTelegramSubagentCompleted,
  splitTelegramText,
} from "./format.js";
import { formatMarkdownAsTelegramHtml } from "./markdown-format.js";
import { formatTelegramPanelChunks } from "./html-format.js";
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
  omittedCount: number;
  messageId: number | undefined;
  timer: NodeJS.Timeout | undefined;
}

interface PlanMessageState {
  tracker: PlanProgressTracker;
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
  readGeneratedImage?: typeof readGeneratedImage;
  exchangeRate?: () => ExchangeRateSnapshot | null;
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency;
  debugEnabled?: boolean;
  opencodeGoUsage?: (
    model: string,
    requestStartedAtMs?: number,
  ) => Promise<ProviderModelUsageEstimate | null>;
}

export class TelegramOutbox {
  private readonly streams = new Map<string, StreamState>();
  private readonly operationLogs = new Map<string, OperationLogState>();
  private readonly operationUpdates = new OperationUpdateBuffer<string>();
  private readonly planMessages = new Map<string, PlanMessageState>();
  private readonly replyTargets = new TurnReplyTargets<number>();
  private readonly typing: TelegramTypingIndicator;
  private readonly delivery: ConversationDeliveryQueue;
  private readonly approvalOperations = new TelegramApprovalOperationCoordinator();
  private readonly notifiedTurns = new Set<string>();
  private streamCapacityWarningIssued = false;
  private closed = false;

  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
    private readonly executor = new TelegramApiExecutor(logger),
    private readonly options: TelegramOutboxOptions = {},
  ) {
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Telegram",
      errorMetadata: (error) => ({ ...telegramErrorMetadata(error) }),
    });
    this.typing = new TelegramTypingIndicator((chatId) => this.enqueueTyping(chatId));
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

  async handle(event: OutputEvent): Promise<void> {
    if (
      this.closed
      || event.target.surface !== "telegram"
      || event.target.accountId !== (this.options.accountId ?? telegramDefaultAccountId)
    ) {
      return;
    }
    const chatId = event.target.conversationId;
    switch (event.type) {
      case "vision.started":
        this.enqueue(
          chatId,
          () => this.sendPanel(
            chatId,
            formatVisionStarted(event.imageCount),
            undefined,
            true,
          ).then(() => undefined),
          false,
        );
        return;
      case "vision.progress":
        this.notifyPanel(chatId, formatVisionProgress(event.elapsedSeconds));
        return;
      case "vision.completed":
        this.notifyPanel(
          chatId,
          formatVisionCompleted(event, this.options.debugEnabled ?? false),
        );
        return;
      case "turn.started":
        this.replyTargets.bindPending(
          chatId,
          this.turnKey(event.threadId, event.turnId),
        );
        this.typing.start(chatId, this.turnActivityKey(event.threadId, event.turnId));
        this.enqueue(
          chatId,
          async () => {
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
            );
          },
          true,
        );
        return;
      case "user.message": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.enqueue(chatId, async () => {
          const messageId = await this.sendPanel(
            chatId,
            formatTelegramCliInput(event.text),
            undefined,
            true,
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
            this.enqueue(chatId, () => this.flush(chatId, key, false), false);
          }, 1_000);
          state.timer.unref();
        }
        return;
      }
      case "text.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        if (event.phase !== "commentary") {
          this.flushOperationUpdates(chatId, turnKey);
        }
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
          () => this.flush(chatId, key, true, existing ? undefined : state),
          true,
        );
        return;
      }
      case "operation.updated": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
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
            () => this.sendImage(chatId, imagePath),
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
        if (this.operationUpdates.accept(turnKey, event.operation, chatId)) {
          return;
        }
        const state = this.operationLogs.get(turnKey) ?? this.createOperationLog(chatId, turnKey);
        if (!state.records.has(event.operation.itemId)) {
          state.order.push(event.operation.itemId);
          if (state.order.length > 100) {
            const removed = state.order.shift();
            if (removed) {
              state.records.delete(removed);
              state.omittedCount += 1;
            }
          }
        }
        state.records.set(event.operation.itemId, event.operation);
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = undefined;
            this.enqueue(
              chatId,
              () => this.flushOperationLog(state, false),
              event.operation.status !== "running",
            );
          }, 750);
          state.timer.unref();
        }
        this.operationLogs.set(turnKey, state);
        return;
      }
      case "plan.updated": {
        if (!this.options.planUpdatesEnabled) {
          return;
        }
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const state = this.planMessages.get(turnKey) ?? {
          tracker: new PlanProgressTracker(),
        };
        this.planMessages.set(turnKey, state);
        for (const presentation of state.tracker.accept(event)) {
          this.enqueue(
            chatId,
            () => this.send(
              chatId,
              presentation.text,
              undefined,
              true,
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
          () => this.sendPanel(
            chatId,
            renderTelegramLifecyclePresentation(
              createSubagentStartedPresentation(event),
            ),
            undefined,
            true,
          ).then(() => undefined),
          false,
        );
        return;
      case "subagent.completed":
        this.enqueue(
          chatId,
          () => this.sendPanel(
            chatId,
            renderTelegramSubagentCompleted(
              event,
              this.options.priceCurrency,
              this.options.exchangeRate?.() ?? null,
              this.options.debugEnabled ?? false,
            ),
            undefined,
            true,
          ).then(() => undefined),
          false,
        );
        return;
      case "turn.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.planMessages.delete(turnKey);
        this.flushOperationUpdates(chatId, turnKey);
        this.sealOperationLog(chatId, turnKey);
        const keys = this.streamKeysForTurn(event.threadId, event.turnId);
        for (const key of keys) {
          const stream = this.streams.get(key);
          if (stream?.timer) {
            clearTimeout(stream.timer);
            stream.timer = undefined;
          }
        }
        this.typing.stop(chatId, this.turnActivityKey(event.threadId, event.turnId));
        const remainingUsage = event.modelProvider === "opencode-go" && event.model
          ? (await this.options.opencodeGoUsage?.(
              event.model,
              event.timing?.modelRequestStartedAtMs,
            )) ?? null
          : null;
        this.enqueue(chatId, async () => {
          for (const key of keys) {
            await this.flush(chatId, key, true);
          }
          const replyTo = this.replyTargets.get(turnKey);
          await this.sendPanel(
            chatId,
            renderTelegramLifecyclePresentation(
              createTurnCompletedPresentation(
                event,
                this.options.priceCurrency,
                this.options.exchangeRate?.() ?? null,
                this.options.debugEnabled ?? false,
                remainingUsage,
              ),
            ),
            replyTo,
            true,
          );
          this.replyTargets.delete(turnKey);
          this.notifiedTurns.delete(turnKey);
          this.clearApprovalOperationsForTurn(turnKey);
        }, true);
        return;
      }
      case "warning":
        this.enqueue(chatId, async () => {
          await this.send(
            chatId,
            formatCodexWarning(visibleUpstreamMessage(event.message)),
            undefined,
            true,
          );
        }, true);
        return;
      case "thread.availability":
        this.enqueue(chatId, async () => {
          await this.send(
            chatId,
            formatThreadAvailability(
              event.availability,
              event.threadId,
              event.background,
            ),
            undefined,
            true,
          );
        }, true);
        return;
      case "connection.lost":
        this.clearThreadOutput(chatId, event.threadId);
        this.enqueue(chatId, async () => {
          await this.send(chatId, formatConnectionLost(event.message));
        }, true);
        return;
      case "account.updated":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatRuntimeAccountUpdate(event.authMode, event.planType),
            undefined,
            true,
          );
        }, true);
        return;
      case "account.rateLimits.updated":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatRuntimeRateLimitUpdate(event.rateLimits),
            undefined,
            true,
          );
        }, true);
        return;
      case "mcp.status.updated":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatRuntimeMcpStatusUpdate(event),
            undefined,
            event.status !== "failed",
          );
        }, event.status === "failed");
        return;
      case "mcp.oauth.completed":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatRuntimeMcpOAuthCompleted(event),
            undefined,
            event.success,
          );
        }, true);
        return;
      case "thread.status":
        return;
    }
  }

  private async sendImage(
    chatId: string,
    imagePath: string,
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
      () => this.api.sendPhoto(
        chatId,
        new InputFile(
          image.bytes,
          `codex-generated-image.${image.format === "jpeg" ? "jpg" : "png"}`,
        ),
        { disable_notification: true },
      ),
    );
  }

  sendChannelImage(chatId: string, imagePath: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      () => this.sendImage(chatId, imagePath),
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
        this.enqueue(state.chatId, () => this.flush(state.chatId, key, true), true);
      }
    }
    for (const [key, state] of this.operationLogs) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if ([...state.records.values()].every((record) => record.status !== "running")) {
        this.operationLogs.delete(key);
        this.enqueue(state.chatId, () => this.flushOperationLog(state, true), true);
      }
    }
    this.typing.close();
    await this.delivery.close();
    this.streams.clear();
    this.operationLogs.clear();
    this.operationUpdates.clear();
    this.planMessages.clear();
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
      this.enqueue(chatId, () => this.flush(chatId, key, state.completed), true);
    }
  }

  finishInteraction(
    chatId: string,
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
      this.enqueue(chatId, () => this.flushOperationLog(state, false), true);
    }
  }

  runOrdered<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Telegram Outbox 已关闭"));
    }
    return this.delivery.runOrdered(chatId, run);
  }

  notifyPanel(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): boolean {
    return this.enqueue(chatId, () => this.sendNotificationPanel(chatId, text, replyMarkup), true);
  }

  deliverPanel(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    return this.runOrdered(chatId, () => this.sendNotificationPanel(chatId, text, replyMarkup));
  }

  private enqueue(chatId: string, run: () => Promise<void>, critical: boolean): boolean {
    return this.delivery.enqueue(chatId, run, critical);
  }

  private async sendNotificationPanel(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    const chunks = formatTelegramPanelChunks(text);
    for (const [index, chunk] of chunks.entries()) {
      const finalChunk = index === chunks.length - 1;
      await this.executor.call(
        { chatId, operation: "sendMessage", critical: true },
        () => this.api.sendMessage(chatId, chunk, {
          ...htmlSendOptions(undefined, index > 0),
          ...(finalChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      );
    }
  }

  private async flush(
    chatId: string,
    key: string,
    final: boolean,
    standaloneState?: StreamState,
  ): Promise<void> {
    const state = standaloneState ?? this.streams.get(key);
    if (!state) {
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
          state.messageId = await this.sendLongFinal(chatId, state, text, longMessage);
          if (!standaloneState) {
            this.streams.delete(key);
          }
          return;
        } catch (error) {
          this.logger.warn(
            { chatId, ...telegramErrorMetadata(error) },
            "Telegram 长回复优化发送失败，回退普通文本",
          );
        }
      }
      if (state.phase === "final_answer") {
        const format = this.options.finalMessageFormat ?? "html";
        const formatted = format === "rich"
          ? canSendRichMarkdown(text) ? text : undefined
          : formatMarkdownAsTelegramHtml(text);
        if (formatted !== undefined) {
          try {
            state.messageId = format === "rich"
              ? await this.sendRichFinal(chatId, state, formatted)
              : await this.sendHtmlFinal(chatId, state, formatted);
            if (!standaloneState) {
              this.streams.delete(key);
            }
            return;
          } catch (error) {
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
    if (state.messageId) {
      try {
        await this.executor.call(
          { chatId, operation: "editMessageText", critical: final },
          () => this.api.editMessageText(chatId, state.messageId!, first),
        );
      } catch (error) {
        if (isMessageNotModified(error)) {
          // The authoritative final text is already visible.
        } else if (final) {
          state.messageId = await this.sendFirstChunk(chatId, state, first);
        } else {
          throw error;
        }
      }
    } else {
      state.messageId = await this.sendFirstChunk(chatId, state, first);
    }
    if (final) {
      for (const chunk of rest) {
        await this.sendMessage(chatId, chunk, undefined, true);
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
    return {
      chatId,
      turnKey,
      order: [],
      records: new Map(),
      omittedCount: 0,
      messageId: undefined,
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
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.records.size === 0 && state.messageId === undefined) {
        this.operationLogs.delete(turnKey);
      }
    }
  }

  private sealOperationLogBeforeInteraction(
    chatId: string,
    turnKey: string,
    state: OperationLogState,
  ): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.operationLogs.delete(turnKey);
    this.enqueue(chatId, () => this.flushOperationLog(state, true), true);
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
    state.order = state.order.filter((candidate) => candidate !== itemId);
    if (state.records.size === 0 && state.messageId === undefined) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      this.operationLogs.delete(turnKey);
    }
  }

  private sealOperationLog(chatId: string, turnKey: string): void {
    const state = this.operationLogs.get(turnKey);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.operationLogs.delete(turnKey);
    this.enqueue(chatId, () => this.flushOperationLog(state, true), true);
  }

  private flushOperationUpdates(chatId: string, turnKey: string): void {
    const buffered = this.operationUpdates.take(turnKey);
    if (buffered === null) {
      return;
    }
    this.enqueueOperationSummary(chatId, buffered.summary, turnKey);
  }

  private flushStreamsBeforeVisibleOutput(chatId: string, turnKey: string): void {
    for (const [key, state] of this.streams) {
      if (state.turnKey !== turnKey || !state.timer) {
        continue;
      }
      clearTimeout(state.timer);
      state.timer = undefined;
      this.enqueue(chatId, () => this.flush(chatId, key, false), true);
    }
  }

  private enqueueOperationSummary(
    chatId: string,
    summary: OperationUpdateSummary,
    turnKey?: string,
  ): void {
    const text = formatTelegramOperationSummary(
      summary,
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
    );
    this.enqueue(
      chatId,
      async () => {
        await this.sendOperationMessage(
          chatId,
          text,
          turnKey === undefined ? undefined : this.replyTargets.get(turnKey),
        );
      },
      true,
    );
  }

  private async flushOperationLog(state: OperationLogState, final: boolean): Promise<void> {
    if (state.records.size === 0) {
      if (state.messageId !== undefined) {
        await this.executor.call(
          { chatId: state.chatId, operation: "deleteMessage", critical: true },
          () => this.api.deleteMessage(state.chatId, state.messageId!),
        );
        state.messageId = undefined;
      }
      return;
    }
    const { chatId, turnKey } = state;
    const text = formatOperationLog(
      state,
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
    );
    if (state.messageId) {
      try {
        await this.executor.call(
          { chatId, operation: "editMessageText", critical: final },
          () => this.api.editMessageText(
            chatId,
            state.messageId!,
            text,
            operationEditOptions(),
          ),
        );
      } catch (error) {
        if (!isMessageNotModified(error)) {
          if (!final) {
            throw error;
          }
          state.messageId = await this.sendOperationMessage(
            chatId,
            text,
            this.replyTargets.get(turnKey),
          );
        }
      }
    } else {
      state.messageId = await this.sendOperationMessage(
        chatId,
        text,
        this.replyTargets.get(turnKey),
      );
    }
    if (final && this.operationLogs.get(turnKey) === state) {
      this.operationLogs.delete(turnKey);
    }
  }

  private async send(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
  ): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of splitTelegramText(text)) {
      const messageId = await this.sendMessage(
        chatId,
        chunk,
        firstMessageId === undefined ? replyTo : undefined,
        silent || firstMessageId !== undefined,
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
  ): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of formatTelegramPanelChunks(text)) {
      const messageId = await this.sendHtmlMessage(
        chatId,
        chunk,
        firstMessageId === undefined ? replyTo : undefined,
        silent || firstMessageId !== undefined,
      );
      firstMessageId ??= messageId;
    }
    return firstMessageId;
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
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

  private async sendFirstChunk(chatId: string, state: StreamState, text: string): Promise<number> {
    const replyTo = state.phase === "commentary"
      ? undefined
      : this.replyTargets.get(state.turnKey);
    const silent = state.phase === "commentary" || this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent)),
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    if (replyTo !== undefined) {
      this.replyTargets.delete(state.turnKey);
    }
    return message.message_id;
  }

  private async sendRichFinal(
    chatId: string,
    state: StreamState,
    markdown: string,
  ): Promise<number> {
    const richMessage: InputRichMessage = { markdown };
    if (state.messageId !== undefined) {
      await this.executor.call(
        { chatId, operation: "editMessageText", critical: true },
        () => this.api.editMessageText(chatId, state.messageId!, richMessage),
      );
      return state.messageId;
    }

    const replyTo = this.replyTargets.get(state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendRichMessage", critical: true },
      () => this.api.sendRichMessage(chatId, richMessage, richReplyOptions(replyTo, silent)),
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    if (replyTo !== undefined) {
      this.replyTargets.delete(state.turnKey);
    }
    return message.message_id;
  }

  private async sendHtmlFinal(
    chatId: string,
    state: StreamState,
    html: string,
  ): Promise<number> {
    if (state.messageId !== undefined) {
      await this.executor.call(
        { chatId, operation: "editMessageText", critical: true },
        () => this.api.editMessageText(chatId, state.messageId!, html, operationEditOptions()),
      );
      return state.messageId;
    }

    const replyTo = this.replyTargets.get(state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, html, htmlSendOptions(replyTo, silent)),
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    if (replyTo !== undefined) {
      this.replyTargets.delete(state.turnKey);
    }
    return message.message_id;
  }

  private async sendLongFinal(
    chatId: string,
    state: StreamState,
    text: string,
    plan: LongFinalMessagePlan,
  ): Promise<number> {
    if (plan.kind === "expandable") {
      return this.sendExpandableFinal(chatId, state, plan.chunks);
    }

    state.messageId = await this.sendHtmlFinal(chatId, state, plan.previewHtml);
    try {
      await this.executor.call(
        { chatId, operation: "sendDocument", critical: true },
        () => this.api.sendDocument(
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
        ),
      );
      return state.messageId;
    } catch (error) {
      this.logger.warn(
        { chatId, ...telegramErrorMetadata(error) },
        "Telegram 完整回复文件发送失败，回退折叠文本",
      );
      return this.sendExpandableFinal(chatId, state, splitExpandableMessage(text));
    }
  }

  private async sendExpandableFinal(
    chatId: string,
    state: StreamState,
    chunks: readonly string[],
  ): Promise<number> {
    const first = chunks[0];
    if (!first) {
      throw new Error("Telegram 折叠回复没有可发送内容");
    }

    if (state.messageId !== undefined) {
      await this.executor.call(
        { chatId, operation: "editMessageText", critical: true },
        () => this.api.editMessageText(
          chatId,
          state.messageId!,
          first,
          expandableEditOptions(first),
        ),
      );
    } else {
      const replyTo = this.replyTargets.get(state.turnKey);
      const silent = this.notifiedTurns.has(state.turnKey);
      const message = await this.executor.call(
        { chatId, operation: "sendMessage", critical: true },
        () => this.api.sendMessage(
          chatId,
          first,
          expandableSendOptions(first, replyTo, silent),
        ),
      );
      state.messageId = message.message_id;
      if (!silent) {
        this.notifiedTurns.add(state.turnKey);
      }
      if (replyTo !== undefined) {
        this.replyTargets.delete(state.turnKey);
      }
    }

    for (const chunk of chunks.slice(1)) {
      await this.executor.call(
        { chatId, operation: "sendMessage", critical: true },
        () => this.api.sendMessage(
          chatId,
          chunk,
          expandableSendOptions(chunk, undefined, true),
        ),
      );
    }
    return state.messageId;
  }

  private async sendMessage(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
  ): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent)),
    );
    return message.message_id;
  }

  private async sendHtmlMessage(
    chatId: string,
    text: string,
    replyTo?: number,
    silent = false,
  ): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, htmlSendOptions(replyTo, silent)),
    );
    return message.message_id;
  }

  private async sendOperationMessage(chatId: string, text: string, replyTo?: number): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, htmlSendOptions(replyTo, true)),
    );
    return message.message_id;
  }

  private enqueueTyping(chatId: string): void {
    if (this.closed) {
      return;
    }
    this.enqueue(chatId, async () => {
      await this.executor.call(
        { chatId, operation: "sendChatAction", critical: false },
        () => this.api.sendChatAction(chatId, "typing"),
      );
    }, false);
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
  const quote = text
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

function visibleUpstreamMessage(message: string): string {
  return message.replaceAll("[REDACTED]", "[已隐藏]");
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
