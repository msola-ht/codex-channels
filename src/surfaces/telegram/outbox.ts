import { SnapshotDelivery } from "../snapshot-delivery.js";
import { surfaceOutputSnapshotKey } from "../delivery-policy.js";
import { isPersistentOutput } from "../persistent-output.js";
import { DeliveryReceipt, captureDelivery, type DeliveryCheckpoint } from "../delivery-receipt.js";
import { TelegramTextStreams, type TelegramFinalMessageFormat } from "./text-streams.js";
import { replyOptions, htmlSendOptions, operationEditOptions } from "./message-options.js";
export type { TelegramFinalMessageFormat } from "./text-streams.js";
import { InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Logger } from "pino";
import { withSurfaceOutputDiagnostics } from "../diagnostics.js";

import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";
import {
  type OperationUpdate,
  type OutputEvent,
} from "../../conversation-core/index.js";
import {
  ConversationDeliveryQueue,
  type ConversationDeliveryOptions,
} from "../conversation-delivery-queue.js";
import { surfaceDeliveryCoalesceKey } from "../delivery-policy.js";
import { readGeneratedImage } from "../generated-image.js";
import {
  OperationUpdateBuffer,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";
import { ContextCompactionNotices, isExecutionOperation, shouldDisplayOperation } from "../operation-presentation.js";
import { TurnReplyTargets } from "../turn-reply-targets.js";
import {
  createSubagentContactedPresentation,
  createAutoApprovalReviewPresentation,
  createHookCompletedPresentation,
  isHiddenAutoApprovalReview,
  createSubagentStartedPresentation,
  createTurnCompletedPresentation,
  createTurnReasoningPresentation,
  createTurnStartedPresentation,
} from "../lifecycle-presentation.js";
import type {
} from "../../application/index.js";
import {
  cliInputTitle,
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
import { TelegramApiExecutor } from "./api-executor.js";
import { TelegramApprovalOperationCoordinator } from "./approval-operation-coordinator.js";
import {
  isTelegramBadRequest,
  telegramErrorMetadata,
} from "./error-metadata.js";
import { telegramAbortSignal } from "./sdk-signal.js";
import { telegramDefaultAccountId } from "./constants.js";
import {
  formatIdleReleaseNotification,
  renderTelegramLifecyclePresentation,
  renderTelegramSubagentCompleted,
  splitTelegramText,
} from "./format.js";
import {
  decodeMarkdownBackslashEscapes,
} from "./markdown-format.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import {
  formatOperationLog,
  formatTelegramOperationSummary,
} from "./operation-format.js";
import { TelegramTypingIndicator } from "./typing-indicator.js";

interface OperationLogState {
  chatId: string;
  turnKey: string;
  order: string[];
  records: Map<string, OperationUpdate>;
  messageIds: Map<string, number>;
  sentText: Map<string, string>;
  refreshKey: string;
  timer: NodeJS.Timeout | undefined;
  releaseTimer?: (() => void) | undefined;
}

interface TelegramReasoningMessage {
  chatId: string;
  threadId: string;
  turnId: string;
  /** 同一 Turn 内每段“思考中”消息的分段编号，用于隔离可合并的中间状态。 */
  segment: number;
  text: string;
  sealed: boolean;
  messageId?: number | undefined;
}

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
  private readonly textStreams: TelegramTextStreams;
  private readonly operationLogs = new Map<string, OperationLogState>();
  private readonly operationUpdates = new OperationUpdateBuffer<string>();
  private readonly planProgress = new TurnPlanProgressState();
  private readonly reasoningMessages = new Map<string, TelegramReasoningMessage>();
  private nextReasoningSegment = 0;
  private nextOperationLogSegment = 0;
  private readonly activeOperations = new Set<string>();
  private readonly snapshots = new SnapshotDelivery();
  private readonly reasoningGenerations = new Map<string, number>();
  private readonly replyTargets = new TurnReplyTargets<number>();
  private readonly typing: TelegramTypingIndicator;
  private readonly compactionNotices = new ContextCompactionNotices();
  private readonly delivery: ConversationDeliveryQueue;
  private readonly approvalOperations = new TelegramApprovalOperationCoordinator();
  private closed = false;

  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
    private readonly executor = new TelegramApiExecutor(logger),
    private readonly options: TelegramOutboxOptions = {},
  ) {
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Telegram",
      maximumPendingOperations: 512,
      errorMetadata: (error) => ({ ...telegramErrorMetadata(error) }),
    });
    this.textStreams = new TelegramTextStreams(
      api, logger, executor, this.delivery, this.replyTargets,
      (chatId, turnKey) => this.sealOperationLog(chatId, turnKey),
      options,
      (chatId, text, replyTo, silent, signal) => this.sendMessage(chatId, text, replyTo, silent, signal),
    );
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

  setTurnReplyTarget(chatId: string, threadId: string, turnId: string, messageId: number): void {
    if (this.closed) {
      return;
    }
    this.replyTargets.set(chatId, this.turnKey(threadId, turnId), messageId);
  }

  observe(event: OutputEvent): void {
    if (this.closed || event.target.surface !== "telegram" || event.target.accountId !== (this.options.accountId ?? telegramDefaultAccountId)) return;
    this.snapshots.observe(event);
    if (event.type === "text.completed" && isEmptyCommentary(event)) this.textStreams.discard(event);
    if (event.type === "turn.started") {
      this.expireRunningOperations(event.threadId, (key) => key !== this.turnKey(event.threadId, event.turnId));
      this.clearExecutionTurns(event.threadId);
      this.reasoningMessages.delete(event.threadId);
      this.replyTargets.bindPending(event.target.conversationId, this.turnKey(event.threadId, event.turnId));
      this.typing.start(event.target.conversationId, this.turnActivityKey(event.threadId, event.turnId));
    } else if (event.type === "turn.completed") {
      this.expireRunningOperations(event.threadId, (key) => key === this.turnKey(event.threadId, event.turnId));
      this.typing.stop(event.target.conversationId, this.turnActivityKey(event.threadId, event.turnId));
    } else if (event.type === "connection.lost") {
      this.clearThreadOutput(event.target.conversationId, event.threadId);
    }
  }

  handle(event: OutputEvent): void | Promise<void> {
    if (
      this.closed
      || event.target.surface !== "telegram"
      || event.target.accountId !== (this.options.accountId ?? telegramDefaultAccountId)
    ) {
      return;
    }
    if (!DeliveryReceipt.current()) this.observe(event);
    if (!DeliveryReceipt.current() && surfaceOutputSnapshotKey(event) !== undefined) {
      const delivery = this.deliverSnapshot(event, new AbortController().signal, () => true);
      // Direct callers may intentionally ignore the asynchronous result; the owner still sees rejection.
      void delivery.catch(() => {});
      return delivery;
    }
    withSurfaceOutputDiagnostics(this.logger, event, () => this.handleEvent(event));
  }

  deliverSnapshot(event: OutputEvent, signal: AbortSignal, authorized: () => boolean): Promise<void> {
    return this.snapshots.run(event, signal, authorized, () => {
      if (this.closed || event.target.surface !== "telegram"
        || event.target.accountId !== (this.options.accountId ?? telegramDefaultAccountId)
        || surfaceOutputSnapshotKey(event) === undefined) throw new Error("状态投递目标无效或已关闭");
      withSurfaceOutputDiagnostics(this.logger, event, () => this.handleEvent(event));
    });
  }

  retains(event: OutputEvent): boolean {
    if (isEmptyCommentary(event)) return false;
    if (event.type === "operation.updated" && this.approvalOperations.isSuppressed(
      this.operationKey(this.turnKey(event.threadId, event.turnId), event.operation.itemId),
    )) return false;
    return isPersistentOutput(event, this.options.operationUpdateDisplay ?? "full");
  }

  async deliver(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>): Promise<void> {
    if (this.closed || event.target.surface !== "telegram"
      || event.target.accountId !== (this.options.accountId ?? telegramDefaultAccountId)) throw new Error("可靠输出目标无效或已关闭");
    signal.throwIfAborted();
    // Existing journal records may contain deliberately hidden, empty commentary.
    // This explicit presentation decision is not evidence that a platform send occurred.
    if (isEmptyCommentary(event) || isHiddenAutoApprovalReview(event)) return;
    if (!this.retains(event)) throw new Error("当前展示规则不允许投递此持久结果");
    await captureDelivery(() => {
      void this.handle(event);
      if (event.type === "operation.updated" && event.operation.status !== "running") {
        const buffered = this.operationUpdates.flushTurn(event);
        if (buffered) this.enqueueOperationSummary(event.target.conversationId, buffered.summary);
      }
    }, signal, checkpoint, { requireConfirmation: event.type === "text.completed" });
  }

  private handleEvent(event: OutputEvent): void {
    const chatId = event.target.conversationId;
    switch (event.type) {
      case "turn.started":
        this.enqueue(
          chatId,
          async () => {
            await this.sendPanel(
              chatId,
              renderTelegramLifecyclePresentation(
                createTurnStartedPresentation(
                  event.background ? event.threadId : undefined,
                  event.identity,
                  event.approvalsReviewer,
                ),
              ),
              this.replyTargets.get(chatId, this.turnKey(event.threadId, event.turnId)),
              true,
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
        this.enqueue(chatId, async () => {
          const messageId = await this.sendPanel(
            chatId,
            formatTelegramCliInput(event.text),
            undefined,
            true,
          );
          if (messageId !== undefined) {
            this.replyTargets.set(chatId, turnKey, messageId);
          }
        }, true);
        return;
      }
      case "text.delta":
        this.textStreams.delta(event);
        return;
      case "text.completed":
        if (isEmptyCommentary(event)) return;
        this.flushOperationUpdates(chatId, event);
        this.sealOperationLog(chatId, this.turnKey(event.threadId, event.turnId));
        this.textStreams.complete(event);
        return;
      case "operation.updated": {
        if (event.operation.kind === "contextCompaction") {
          const text = this.compactionNotices.accept(event, DeliveryReceipt.current() !== undefined);
          if (text !== null) {
            this.textStreams.flushBeforeVisibleOutput(chatId, this.turnKey(event.threadId, event.turnId));
            this.enqueue(chatId, async (signal) => {
              await this.sendOperationMessage(chatId, text, undefined, signal);
            }, true);
          }
          return;
        }
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
            this.sealReasoningMessage(chatId, event.threadId, event.turnId);
          }
        }
        let streamFlushed = false;
        const flushStreamBeforeOutput = (): void => {
          if (streamFlushed) {
            return;
          }
          streamFlushed = true;
          this.textStreams.flushBeforeVisibleOutput(chatId, turnKey);
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
        }, event.operation.status === "running");
        if (disposition === "suppress") {
          return;
        }
        if (disposition === "hold") {
          return;
        }
        flushStreamBeforeOutput();
        if (this.operationUpdates.accept(event, chatId)) {
          return;
        }
        const state = this.operationLogFor(chatId, turnKey) ?? this.createOperationLog(chatId, turnKey);
        if (!state.records.has(event.operation.itemId)) {
          state.order.push(event.operation.itemId);
          if (state.order.length > 100) {
            const removed = state.order.shift();
            if (removed) {
              state.records.delete(removed);
              state.messageIds.delete(removed);
              state.sentText.delete(removed);
            }
          }
        }
        state.records.set(event.operation.itemId, event.operation);
        if (event.operation.status !== "running") {
          this.cancelOperationTimer(state);
          this.enqueue(chatId, (signal) => this.flushOperationLog(state, false, signal), true, { purpose: "operation-log" });
        } else if (!state.timer) {
          const receipt = DeliveryReceipt.current();
          const release = receipt?.retain();
          const cancel = (): void => this.cancelOperationTimer(state);
          state.releaseTimer = () => {
            receipt?.controller.signal.removeEventListener("abort", cancel);
            release?.();
          };
          state.timer = setTimeout(() => {
            state.timer = undefined;
            const finish = state.releaseTimer;
            state.releaseTimer = undefined;
            this.enqueue(
              chatId,
              (signal) => this.flushOperationLog(state, false, signal),
              false,
              { coalesceKey: state.refreshKey, purpose: "operation-log" },
            );
            finish?.();
          }, 750);
          receipt?.controller.signal.addEventListener("abort", cancel, { once: true });
          if (receipt?.controller.signal.aborted) cancel();
          state.timer?.unref();
        }
        this.operationLogs.set(turnKey, state);
        return;
      }
      case "plan.updated": {
        if (!this.options.planUpdatesEnabled) {
          return;
        }
        this.enqueue(chatId, async (signal) => {
          try {
            for (const presentation of this.planProgress.accept(event)) {
              await this.send(chatId, presentation.text, undefined, true, signal);
            }
          } catch (error) {
            // A failed presentation must not suppress the next live plan update.
            this.planProgress.clearThread(event.threadId);
            throw error;
          }
        }, true);
        return;
      }
      case "subagent.spawned":
        this.textStreams.flushBeforeVisibleOutput(
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
        this.textStreams.flushBeforeVisibleOutput(
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
      case "hook.completed":
        this.enqueue(chatId, (signal) => this.sendPanel(
          chatId, renderTelegramLifecyclePresentation(createHookCompletedPresentation(event)),
          undefined, true, signal,
        ).then(() => undefined), true);
        return;
      case "autoApprovalReview.updated": {
        const presentation = createAutoApprovalReviewPresentation(event);
        if (!presentation) return;
        this.enqueue(chatId, (signal) => this.sendPanel(
          chatId,
          renderTelegramLifecyclePresentation(presentation),
          undefined,
          true,
          signal,
        ).then(() => undefined), true);
        return;
      }
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
        const flushText = this.textStreams.prepareTurnCompletion(chatId, event.threadId, event.turnId);
        this.typing.stop(chatId, this.turnActivityKey(event.threadId, event.turnId));
        this.enqueue(chatId, async (signal) => {
          await flushText(chatId, signal);
          const replyTo = this.replyTargets.get(chatId, turnKey);
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
            this.replyTargets.delete(chatId, turnKey);
            this.textStreams.clearTurnNotification(turnKey);
            this.clearApprovalOperationsForTurn(turnKey);
          }
        }, true, { purpose: "turn-completion" });
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
      case "conversation.idle.released":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatIdleReleaseNotification(event.minutes, event.threadId),
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
        this.enqueue(chatId, async () => {
          await this.send(chatId, formatConnectionLost(event.message));
        }, true);
        return;
      case "connection.restored":
        this.enqueue(chatId, async () => {
          await this.send(chatId, formatConnectionRestored(event.message));
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
      case "thread.name":
        // 与其他输出一致：同步入队后由 Conversation 队列串行发送，不在共享输出路由线程里
        // 等待平台请求（否则一次改名会阻塞所有渠道的输出投递）。
        this.enqueue(
          chatId,
          (signal) => this.sendPanel(
            chatId,
            `Session 名称已更新：${event.name ?? "未命名"}`,
            undefined,
            true,
            signal,
          ).then(() => undefined),
          true,
        );
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
        telegramAbortSignal(requestSignal),
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
    this.textStreams.prepareClose();
    for (const [key, state] of this.operationLogs) {
      this.cancelOperationTimer(state);
      if ([...state.records.values()].every((record) => record.status !== "running")) {
        this.operationLogs.delete(key);
        this.enqueue(state.chatId, (signal) => this.flushOperationLog(state, true, signal), true);
      }
    }
    this.typing.close();
    await this.delivery.close();
    this.textStreams.clear();
    this.operationLogs.clear();
    this.operationUpdates.clear();
    this.planProgress.clear();
    this.reasoningMessages.clear();
    this.activeOperations.clear();
    this.reasoningGenerations.clear();
    this.replyTargets.clear();
    this.approvalOperations.clear();
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
    this.textStreams.prepareInteraction(chatId);
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
    let state = this.operationLogFor(chatId, turnKey);
    if (resolution.rejected) {
      this.removeOperationFromLog(turnKey, request.itemId, state);
    }
    if (resolution.pending || resolution.suppressed) {
      return;
    }
    const held = resolution.held;
    if (held) {
      state = this.operationLogFor(held.chatId, turnKey) ?? this.createOperationLog(held.chatId, turnKey);
      if (!state.records.has(request.itemId)) {
        state.order.push(request.itemId);
      }
      state.records.set(request.itemId, held.operation);
      this.operationLogs.set(turnKey, state);
    }
    if (state?.records.has(request.itemId)) {
      this.cancelOperationTimer(state);
      this.enqueue(chatId, (signal) => this.flushOperationLog(state, false, signal), true, { purpose: "operation-log" });
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
    options?: ConversationDeliveryOptions,
  ): boolean {
    return this.delivery.enqueue(chatId, run, critical, options);
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
        }, telegramAbortSignal(requestSignal)),
        signal,
      );
    }
  }

  private operationLogFor(chatId: string, turnKey: string): OperationLogState | undefined {
    const state = this.operationLogs.get(turnKey);
    return state?.chatId === chatId ? state : undefined;
  }

  private createOperationLog(chatId: string, turnKey: string): OperationLogState {
    return {
      chatId,
      turnKey,
      order: [],
      records: new Map(),
      messageIds: new Map(),
      sentText: new Map(),
      refreshKey: `telegram:operations:${++this.nextOperationLogSegment}`,
      timer: undefined,
    };
  }

  private holdApprovalOperation(chatId: string, request: InteractionRequest): void {
    if (request.type !== "approval") {
      return;
    }
    const turnKey = this.turnKey(request.threadId, request.turnId);
    const state = this.operationLogFor(chatId, turnKey);
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
        state.sentText.delete(request.itemId);
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
                telegramAbortSignal(requestSignal),
              ),
              signal,
            ).then(() => undefined),
            true,
          );
        }
      }
      this.cancelOperationTimer(state);
      if (state.records.size === 0 && state.messageIds.size === 0) {
        this.operationLogs.delete(turnKey);
      }
    }
  }

  private sealOperationLogBeforeInteraction(
    chatId: string,
    turnKey: string,
    state: OperationLogState,
  ): void {
    this.cancelOperationTimer(state);
    this.operationLogs.delete(turnKey);
    this.enqueue(chatId, (signal) => this.flushOperationLog(state, true, signal), true, { purpose: "operation-log" });
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
    state.sentText.delete(itemId);
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
            telegramAbortSignal(requestSignal),
          ),
          signal,
        ).then(() => undefined),
        true,
      );
    }
    if (state.records.size === 0 && state.messageIds.size === 0) {
      this.cancelOperationTimer(state);
      this.operationLogs.delete(turnKey);
    }
  }

  private sealOperationLog(chatId: string, turnKey: string): void {
    const state = this.operationLogFor(chatId, turnKey);
    if (!state) {
      return;
    }
    this.cancelOperationTimer(state);
    this.operationLogs.delete(turnKey);
    this.enqueue(chatId, (signal) => this.flushOperationLog(state, true, signal), true, { purpose: "operation-log" });
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

  private async flushOperationLog(
    state: OperationLogState,
    final: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (state.records.size === 0) {
      return;
    }
    const { chatId, turnKey } = state;
    const display = this.options.operationUpdateDisplay === "compact"
      ? "compact"
      : "full";
    const records = state.order
      .map((itemId) => state.records.get(itemId))
      .filter((record): record is OperationUpdate => record !== undefined);
    for (const record of records) {
      const text = formatOperationLog({
        order: [record.itemId],
        records: new Map([[record.itemId, record]]),
      }, display);
      const messageId = state.messageIds.get(record.itemId);
      if (messageId !== undefined && state.sentText.get(record.itemId) === text) {
        continue;
      }
      if (messageId === undefined) {
        state.messageIds.set(
          record.itemId,
          await this.sendOperationMessage(chatId, text, undefined, signal),
        );
        state.sentText.set(record.itemId, text);
        continue;
      }
      try {
        await this.executor.editMessageText(
          { chatId, critical: final || record.status !== "running" },
          (requestSignal) => this.api.editMessageText(
            chatId,
            messageId,
            text,
            operationEditOptions(),
            telegramAbortSignal(requestSignal),
          ),
          signal,
        );
      } catch (error) {
        if (!final || signal?.aborted || !isTelegramBadRequest(error)) throw error;
        state.messageIds.set(record.itemId, await this.sendOperationMessage(chatId, text, undefined, signal));
      }
      state.sentText.set(record.itemId, text);
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
    const editText = formatTelegramPanelChunks(text)[0] ?? text;
    const existing = this.reasoningMessages.get(event.threadId);
    if (existing !== undefined && (existing.turnId !== event.turnId || existing.chatId !== event.target.conversationId)) {
      this.reasoningMessages.delete(event.threadId);
      this.deliverReasoning(event, generation);
      return;
    }
    if (existing === undefined) {
      if (event.final === true) {
        this.enqueue(
          chatId,
          (signal) => (this.reasoningGenerations.get(this.turnKey(event.threadId, event.turnId)) ?? 0) !== generation
            || this.hasActiveOperation(event.threadId, event.turnId)
            ? Promise.resolve()
            : this.sendPanel(chatId, text, undefined, false, signal).then(() => undefined),
          true,
        );
        return;
      }
      const state: TelegramReasoningMessage = {
        chatId,
        threadId: event.threadId,
        turnId: event.turnId,
        segment: this.nextReasoningSegment++,
        text,
        sealed: false,
      };
      this.reasoningMessages.set(event.threadId, state);
      this.enqueue(
        chatId,
        async (signal) => {
          if ((this.reasoningGenerations.get(this.turnKey(event.threadId, event.turnId)) ?? 0) !== generation
            || this.hasActiveOperation(event.threadId, event.turnId)) {
            if (this.reasoningMessages.get(event.threadId) === state) {
              this.reasoningMessages.delete(event.threadId);
            }
            return;
          }
          state.messageId = await this.sendPanel(chatId, text, undefined, false, signal);
          if (state.sealed) {
            this.enqueueReasoningSeal(state);
          }
        },
        true,
      );
      return;
    }
    if (event.final === true) {
      this.reasoningMessages.delete(event.threadId);
    }
    existing.text = text;
    const coalesceKey = surfaceDeliveryCoalesceKey(event, existing.segment);
    this.enqueue(
      chatId,
      async (signal) => {
        if ((this.reasoningGenerations.get(this.turnKey(event.threadId, event.turnId)) ?? 0) !== generation
          || this.hasActiveOperation(event.threadId, event.turnId)) {
          return;
        }
        if (existing.messageId === undefined) {
          existing.messageId = await this.sendPanel(chatId, text, undefined, false, signal);
          return;
        }
        try {
          await this.executor.editMessageText(
            { chatId, critical: event.final === true },
            (requestSignal) => this.api.editMessageText(
              chatId,
              existing.messageId!,
              editText,
              operationEditOptions(),
              telegramAbortSignal(requestSignal),
            ),
            signal,
          );
        } catch (error) {
          if (event.final === true && !signal?.aborted && isTelegramBadRequest(error)) {
            existing.messageId = await this.sendPanel(chatId, text, undefined, false, signal);
          } else {
            throw error;
          }
        }
      },
      true,
      coalesceKey === undefined ? undefined : { coalesceKey },
    );
  }

  private sealReasoningMessage(chatId: string, threadId: string, turnId: string): void {
    const state = this.reasoningMessages.get(threadId);
    if (state === undefined || state.turnId !== turnId || state.chatId !== chatId) {
      return;
    }
    this.reasoningMessages.delete(threadId);
    state.sealed = true;
    if (state.messageId === undefined) {
      return;
    }
    this.enqueueReasoningSeal(state);
  }

  private enqueueReasoningSeal(state: TelegramReasoningMessage): void {
    if (state.messageId === undefined) {
      return;
    }
    const completedText = state.text.replace("思考中…", "思考完成");
    const formattedCompletedText = formatTelegramPanelChunks(completedText)[0]
      ?? completedText;
    this.enqueue(
      state.chatId,
      (signal) => this.executor.editMessageText(
        {
          chatId: state.chatId,
          critical: true,
        },
        (requestSignal) => this.api.editMessageText(
          state.chatId,
          state.messageId!,
          formattedCompletedText,
          operationEditOptions(),
          telegramAbortSignal(requestSignal),
        ),
        signal,
      ).then(() => undefined),
      true,
    );
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

  private turnActivityKey(threadId: string, turnId: string): string {
    return `turn:${this.turnKey(threadId, turnId)}`;
  }

  private operationKey(turnKey: string, itemId: string): string {
    return `${turnKey}:${itemId}`;
  }

  private clearApprovalOperationsForTurn(turnKey: string): void {
    this.approvalOperations.clearTurn(turnKey);
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
      (requestSignal) => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent), telegramAbortSignal(requestSignal)),
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
      (requestSignal) => this.api.sendMessage(chatId, text, htmlSendOptions(replyTo, silent), telegramAbortSignal(requestSignal)),
      signal,
    );
    return message.message_id;
  }

  private async sendOperationMessage(chatId: string, text: string, replyTo?: number, signal?: AbortSignal): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      (requestSignal) => this.api.sendMessage(chatId, text, htmlSendOptions(replyTo, true), telegramAbortSignal(requestSignal)),
      signal,
    );
    return message.message_id;
  }

  private enqueueTyping(chatId: string): void {
    if (this.closed) {
      return;
    }
    this.enqueue(chatId, async (signal) => {
      await this.executor.call(
        { chatId, operation: "sendChatAction", critical: false },
        (requestSignal) => this.api.sendChatAction(chatId, "typing", {}, telegramAbortSignal(requestSignal)),
        signal,
      );
    }, false, { coalesceKey: "telegram:typing" });
  }

  private expireRunningOperations(threadId: string, matches: (turnKey: string) => boolean): void {
    for (const [key, state] of this.operationLogs) {
      if (!key.startsWith(`${threadId}:`) || !matches(key)) continue;
      this.cancelOperationTimer(state);
      for (const [itemId, operation] of state.records) {
        if (operation.status === "running") state.records.delete(itemId);
      }
      state.order = state.order.filter((itemId) => state.records.has(itemId));
      if (state.records.size === 0) this.operationLogs.delete(key);
    }
  }

  private cancelOperationTimer(state: OperationLogState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const release = state.releaseTimer;
    state.releaseTimer = undefined;
    release?.();
  }

  private clearThreadOutput(chatId: string, threadId: string): void {
    this.clearExecutionTurns(threadId);
    this.reasoningMessages.delete(threadId);
    this.operationUpdates.clearThread(threadId);
    this.planProgress.clearThread(threadId);
    this.textStreams.clearThread(threadId);
    for (const [key, state] of this.operationLogs) {
      if (state.turnKey.startsWith(`${threadId}:`)) {
        this.cancelOperationTimer(state);
        this.operationLogs.delete(key);
      }
    }
    this.replyTargets.clearThread(threadId);
    this.approvalOperations.clearThread(threadId);
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

function isEmptyCommentary(event: OutputEvent): boolean {
  return event.type === "text.completed" && event.phase === "commentary" && !event.text.trim();
}
