import { SnapshotDelivery } from "../snapshot-delivery.js";
import { surfaceOutputSnapshotKey } from "../delivery-policy.js";
import { isPersistentOutput } from "../persistent-output.js";
import { isHiddenAutoApprovalReview } from "../lifecycle-presentation.js";
import { DeliveryReceipt, captureDelivery, type DeliveryCheckpoint } from "../delivery-receipt.js";
import { FeishuTextStreams } from "./text-streams.js";
import type { Logger } from "pino";
import { withSurfaceOutputDiagnostics, surfaceDiagnosticContext } from "../diagnostics.js";

import {
  isCriticalOutputEvent,
  type OutputEvent,
  type TurnStartIdentity,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { surfaceDeliveryCoalesceKey } from "../delivery-policy.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import type {
} from "../../application/index.js";
import { readGeneratedImage } from "../generated-image.js";
import { formatConversationIdleReleased } from "../output-copy.js";
import {
  OperationUpdateBuffer,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";
import { ContextCompactionNotices, isComputerUseOperation, isExecutionOperation, shouldDisplayOperation } from "../operation-presentation.js";
import {
  createPlanPresentation,
  type PlanPresentation,
} from "../plan-presentation.js";
import { TurnReplyTargets } from "../turn-reply-targets.js";
import type {
  OperationUpdateDisplay,
  SurfaceOutputPort,
} from "../types.js";
import type { FeishuCardDocument } from "./approval-card.js";
import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";
import { FeishuMessageError } from "./message-error.js";
import { bindOutboxMessagePort, type FeishuMessagePort, type ObserveFeishuCardCreation } from "./outbox-message-port.js";
export type { FeishuMessagePort } from "./outbox-message-port.js";
import { renderFeishuConversationIdleReleasedCard } from "./idle-release-card.js";
import {
  formatFeishuOperation,
  formatFeishuOperationSummary,
  renderFeishuComputerUseCard,
} from "./operation-format.js";
import {
  feishuPreviewNotice,
  maximumFeishuMessageChunks,
  maximumFeishuStreamingCards,
  maximumFeishuStreamingElementCharacters,
  splitFeishuMarkdownCards,
  splitFeishuPost,
  splitFeishuStreamingContent,
  splitFeishuText,
} from "./outbox-content.js";
import { renderFeishuOutput } from "./renderer.js";
import {
  renderFeishuPlanCard,
  renderFeishuThreadStatusCard,
} from "./status-card.js";

const maximumFeishuFinalAnswerFileBytes = 1_000_000;
const feishuFinalAnswerFileName = "codex-final-answer.txt";
const maximumFeishuFinalPreviewCharacters = 1_200;
const feishuFileFailureNotice = "[完整文件发送失败，已改为分段文本]\n\n";

interface FeishuPlanState {
  chatId: string;
  messageId?: string;
  fingerprint?: string;
}

interface FeishuReasoningCard {
  chatId: string;
  threadId: string;
  turnId: string;
  /** 同一 Turn 内每段“思考中”卡片的分段编号，用于隔离可合并的中间状态。 */
  segment: number;
  cardId?: string;
  sequence: number;
  lastText?: string;
}


export interface FeishuOutboxOptions {
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

export class FeishuOutbox implements SurfaceOutputPort {
  private readonly textStreams: FeishuTextStreams;
  private readonly compactionNotices = new ContextCompactionNotices();
  private readonly delivery: ConversationDeliveryQueue;
  private readonly messagePort: FeishuMessagePort;
  private readonly deliveryAbort = new AbortController();
  private readonly threadStatusMessages = new Map<
    string,
    {
      chatId: string;
      messageId: string;
      status: string;
      identity?: TurnStartIdentity;
    }
  >();
  private readonly planMessages = new Map<
    string,
    FeishuPlanState
  >();
  private readonly reasoningCards = new Map<string, FeishuReasoningCard>();
  private nextReasoningSegment = 0;
  private readonly activeOperations = new Set<string>();
  private readonly snapshots = new SnapshotDelivery();
  private readonly reasoningGenerations = new Map<string, number>();
  private readonly operationDisplays = new Map<string, { chatId: string; markdown: string }>();
  private readonly computerUseCards = new Map<string, { chatId: string; messageId?: string }>();
  private readonly pendingApprovalOperations = new Set<string>();
  private readonly heldApprovalOperations = new Map<string, Extract<OutputEvent, { type: "operation.updated" }>['operation']>();
  private readonly operationUpdates = new OperationUpdateBuffer<string>();
  private readonly replyTargets = new TurnReplyTargets<string>();
  private closed = false;
  private closeFinished = false;

  constructor(
    private readonly accountId: string,
    messagePort: FeishuMessagePort,
    private readonly logger: Logger,
    private readonly options: FeishuOutboxOptions = {},
  ) {
    this.messagePort = bindOutboxMessagePort(messagePort, this.deliveryAbort.signal);
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Feishu",
      maximumPendingOperations: 512,
      drainOnClose: true,
    });
    this.textStreams = new FeishuTextStreams(
      this.messagePort, this.delivery, this.replyTargets, logger,
      () => this.closeFinished,
      (chatId, markdown, maximumChunks, replyTo, onFirstMessageId, signal, truncationNotice) =>
        this.sendMarkdown(chatId, markdown, maximumChunks, replyTo, onFirstMessageId, signal, truncationNotice),
      (chatId, markdown, maximumChunks, signal, replyTo, truncationNotice) => this.sendPost(chatId, markdown, maximumChunks, signal, replyTo, truncationNotice),
    );
  }

  observe(event: OutputEvent): void {
    if (this.closed || event.target.surface !== "feishu" || event.target.accountId !== this.accountId) return;
    this.snapshots.observe(event);
    if (event.type === "turn.started") {
      this.clearExecutionTurns(event.threadId);
      this.reasoningCards.delete(event.threadId);
      this.replyTargets.bindPending(event.target.conversationId, turnKey(event.threadId, event.turnId));
    } else if (event.type === "connection.lost") {
      this.clearExecutionTurns(event.threadId);
      this.reasoningCards.delete(event.threadId);
      this.replyTargets.clearThread(event.threadId);
      this.textStreams.clearThread(event.threadId);
      this.operationUpdates.clearThread(event.threadId);
      for (const key of this.planMessages.keys()) {
        if (key.startsWith(`${event.threadId}:`)) this.planMessages.delete(key);
      }
      for (const key of this.heldApprovalOperations.keys()) {
        if (key.startsWith(`${event.threadId}:`)) this.heldApprovalOperations.delete(key);
      }
      for (const key of this.pendingApprovalOperations) {
        if (key.startsWith(`${event.threadId}:`)) this.pendingApprovalOperations.delete(key);
      }
    }
  }

  handle(event: OutputEvent): void | Promise<void> {
    if (
      this.closed
      || event.target.surface !== "feishu"
      || event.target.accountId !== this.accountId
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
      if (this.closed || event.target.surface !== "feishu"
        || event.target.accountId !== this.accountId
        || surfaceOutputSnapshotKey(event) === undefined) throw new Error("状态投递目标无效或已关闭");
      withSurfaceOutputDiagnostics(this.logger, event, () => this.handleEvent(event));
    });
  }

  retains(event: OutputEvent): boolean {
    return isPersistentOutput(event, this.options.operationUpdateDisplay ?? "full");
  }

  async deliver(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>): Promise<void> {
    if (this.closed || event.target.surface !== "feishu"
      || event.target.accountId !== this.accountId) throw new Error("可靠输出目标无效或已关闭");
    signal.throwIfAborted();
    if (isHiddenAutoApprovalReview(event)) return;
    if (!this.retains(event)) throw new Error("当前展示规则不允许投递此持久结果");
    await captureDelivery(() => {
      void this.handle(event);
      if (event.type === "text.completed") {
        // Runs after the rendered output. Preview success alone cannot ACK a
        // truncated result; an already-confirmed full file avoids a duplicate.
        this.delivery.enqueue(event.target.conversationId, async (active) => {
          const receipt = DeliveryReceipt.current();
          if (!receipt?.needsCompleteContent()) return;
          await this.sendCompleteContentFile(event.target.conversationId, event.text, active);
        }, true);
      }
      if (event.type === "operation.updated" && event.operation.status !== "running") {
        const buffered = this.operationUpdates.flushTurn(event);
        if (buffered) this.enqueueOperationSummary(event.target.conversationId, buffered.summary);
      }
    }, signal, checkpoint, { requireConfirmation: event.type === "text.completed" });
  }

  private handleEvent(event: OutputEvent): void {
    if (event.type === "text.delta") {
      this.textStreams.acceptStreamDelta(event);
      return;
    }
    if (event.type === "turn.reasoning") {
      if (this.options.reasoningEnabled === false) {
        return;
      }
      if (this.hasActiveOperation(event.threadId, event.turnId)) {
        return;
      }
      this.logger.debug(
        {
          component: "Feishu",
          threadId: event.threadId,
          turnId: event.turnId,
          elapsedMs: event.elapsedMs,
          final: event.final === true,
        },
        "飞书收到思考状态事件",
      );
      this.deliverReasoning(
        event,
        this.reasoningGenerations.get(turnKey(event.threadId, event.turnId)) ?? 0,
      );
      return;
    }
    if (event.type === "text.completed") {
      this.flushOperationUpdates(event.target.conversationId, event);
      if (this.textStreams.completeStream(event, this.canSendCompleteContentFile(event.text)
        && (DeliveryReceipt.current() !== undefined
          || (event.phase !== "commentary" && this.canSendCompletedAnswerFile(event.text))))) {
        this.enqueueCompletedAnswerFile(event);
        return;
      }
    }
    if (event.type === "operation.updated") {
      if (event.operation.kind === "contextCompaction") {
        const text = this.compactionNotices.accept(event, DeliveryReceipt.current() !== undefined);
        if (text !== null) {
          this.textStreams.flushStreamsBeforeVisibleOutput(event.target.conversationId, event.threadId, event.turnId);
          this.delivery.enqueue(event.target.conversationId,
            (signal) => this.sendMarkdown(event.target.conversationId, text, maximumFeishuMessageChunks, undefined, undefined, signal), true);
        }
        return;
      }
      if (isExecutionOperation(event.operation)) {
        const turn = turnKey(event.threadId, event.turnId);
        const key = this.operationKey(event.threadId, event.turnId, event.operation.itemId);
        if (event.operation.status === "running") {
          this.activeOperations.add(key);
          this.reasoningGenerations.set(turn, (this.reasoningGenerations.get(turn) ?? 0) + 1);
          this.sealReasoningCard(event.target.conversationId, event.threadId, event.turnId);
        } else {
          this.activeOperations.delete(key);
        }
      }
      let streamFlushed = false;
      const flushStreamBeforeOutput = (): void => {
        if (streamFlushed) {
          return;
        }
        streamFlushed = true;
        this.textStreams.flushStreamsBeforeVisibleOutput(event.target.conversationId, event.threadId, event.turnId);
      };
      const imagePath = event.operation.imagePath;
      if (
        event.operation.kind === "imageGeneration"
        && event.operation.status === "completed"
        && imagePath !== undefined
      ) {
        flushStreamBeforeOutput();
        this.delivery.enqueue(
          event.target.conversationId,
          (signal) => this.sendImage(
            event.target.conversationId,
            imagePath,
            signal,
          ),
          true,
        );
      }
      if (!shouldDisplayOperation(
        event.operation,
        this.options.operationUpdateDisplay ?? "full",
      )) {
        return;
      }
      if (
        event.operation.kind === "webSearch"
        && event.operation.status === "completed"
      ) {
        flushStreamBeforeOutput();
        const markdown = formatFeishuOperation(
          event.operation,
          this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
        );
        this.delivery.enqueue(
          event.target.conversationId,
          (signal) => this.sendMarkdown(event.target.conversationId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal),
          true,
        );
        return;
      }
      if (
        event.operation.status !== "running"
        && this.operationUpdates.accept(event, event.target.conversationId)
      ) {
        return;
      }
      if (event.operation.status === "running") {
        const operationKey = this.operationKey(event.threadId, event.turnId, event.operation.itemId);
        if (this.pendingApprovalOperations.has(operationKey)) {
          this.heldApprovalOperations.set(operationKey, event.operation);
          return;
        }
        if (!isComputerUseOperation(event.operation)) return;
      }
      flushStreamBeforeOutput();
      const markdown = formatFeishuOperation(event.operation, this.options.operationUpdateDisplay === "compact" ? "compact" : "full");
      if (isComputerUseOperation(event.operation)) {
        const key = this.operationKey(event.threadId, event.turnId, event.operation.itemId);
        const previous = this.computerUseCards.get(key);
        const state = previous?.chatId === event.target.conversationId ? previous : { chatId: event.target.conversationId };
        this.computerUseCards.set(key, state);
        this.delivery.enqueue(
          event.target.conversationId,
          async (signal) => {
            if (!this.acceptOperationDisplay(event, markdown)) return;
            try { await this.deliverComputerUseCard(event, state, markdown, signal); }
            catch (error) {
              const displayed = this.operationDisplays.get(key);
              if (displayed?.chatId === event.target.conversationId && displayed.markdown === markdown) this.operationDisplays.delete(key);
              throw error;
            }
          },
          isCriticalOutputEvent(event),
        );
        return;
      }
      if (!this.acceptOperationDisplay(event, markdown)) return;
      this.delivery.enqueue(event.target.conversationId, (signal) => this.sendMarkdown(event.target.conversationId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal), isCriticalOutputEvent(event));
      return;
    }
    if (event.type === "plan.updated") {
      if (!this.options.planUpdatesEnabled) {
        return;
      }
      const key = turnKey(event.threadId, event.turnId);
      const previous = this.planMessages.get(key);
      const state = previous?.chatId === event.target.conversationId ? previous : { chatId: event.target.conversationId };
      this.planMessages.set(key, state);
      const snapshot = createPlanPresentation(event);
      this.delivery.enqueue(
        event.target.conversationId,
        (signal) => this.deliverPlanSnapshot(
          event.target.conversationId,
          state,
          snapshot,
          signal,
        ),
        true,
      );
      return;
    }
    if (event.type === "turn.completed") {
      this.planMessages.delete(turnKey(event.threadId, event.turnId));
      const prefix = `${turnKey(event.threadId, event.turnId)}\u0000`;
      for (const key of this.computerUseCards.keys()) {
        if (key.startsWith(prefix)) this.computerUseCards.delete(key);
      }
      this.flushOperationUpdates(event.target.conversationId, event);
      const completion = renderFeishuOutput(
        event,
        this.options.debugEnabled ?? false,
        this.options.autoCompactPercent,
      );
      if (
        completion !== null
        && this.textStreams.finishStreamsForTurn(
          event.target.conversationId, event.threadId, event.turnId, completion,
          () => this.replyTargets.delete(event.target.conversationId, turnKey(event.threadId, event.turnId)),
        )
      ) {
        return;
      }
    }
    if (event.type === "thread.status") {
      this.delivery.enqueue(
        event.target.conversationId,
        (signal) => this.deliverThreadStatus(event, signal),
        true,
      );
      return;
    }
    if (event.type === "conversation.idle.released") {
      const card = renderFeishuConversationIdleReleasedCard(
        event.minutes,
        event.threadId,
      );
      this.delivery.enqueue(
        event.target.conversationId,
        (signal) => this.messagePort
          .sendCard(event.target.conversationId, card, signal)
          .then(
            () => undefined,
            (error) => {
              this.logger.warn(
                {
                  component: "Feishu",
                  fallback: "markdown",
                  errorType: error instanceof Error ? error.name : typeof error,
                },
                "飞书空闲解除 CardKit 创建失败，已降级为 Markdown",
              );
              return this.sendMarkdown(
                event.target.conversationId,
                formatConversationIdleReleased(
                  event.minutes,
                  event.threadId,
                ),
                maximumFeishuMessageChunks,
                undefined,
                undefined,
                signal,
              );
            },
          ),
        true,
      );
      return;
    }
    const rendered = renderFeishuOutput(
      event,
      this.options.debugEnabled ?? false,
      this.options.autoCompactPercent,
    );
    if (rendered === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      (signal) => event.type === "subagent.spawned"
          || event.type === "subagent.contacted"
          || event.type === "subagent.completed"
          || event.type === "autoApprovalReview.updated"
          || event.type === "hook.completed"
          || event.type === "account.updated"
          || event.type === "account.rateLimits.updated"
          || event.type === "mcp.oauth.completed"
          || event.type === "mcp.status.updated"
        ? this.sendMarkdown(event.target.conversationId, rendered, maximumFeishuMessageChunks, undefined, undefined, signal)
        : event.type === "turn.started"
          || event.type === "text.completed"
          || event.type === "turn.completed"
        ? this.sendTurnMarkdown(event, rendered, signal)
        : this.sendText(event.target.conversationId, rendered, signal),
      event.type === "turn.started" || isCriticalOutputEvent(event),
    );
  }

  private async deliverComputerUseCard(
    event: Extract<OutputEvent, { type: "operation.updated" }>,
    state: { messageId?: string },
    markdown: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const card = renderFeishuComputerUseCard(
      event.operation,
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
    );
    if (state.messageId === undefined) {
      state.messageId = await this.messagePort.sendCard(event.target.conversationId, card, signal);
      return;
    }
    try {
      await this.messagePort.updateCard(state.messageId, card, signal);
    } catch (error) {
      if (signal?.aborted || event.operation.status === "running") throw error;
      this.logger.warn(
        { component: "Feishu", fallback: "markdown", ...surfaceErrorMetadata(error) },
        "飞书电脑与浏览器操作卡片更新失败，已改为发送终态消息",
      );
      await this.sendMarkdown(event.target.conversationId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal);
    }
  }

  private async deliverPlanSnapshot(
    chatId: string,
    state: FeishuPlanState,
    presentation: PlanPresentation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (state.fingerprint === presentation.fingerprint) {
      return;
    }
    const card = renderFeishuPlanCard(presentation);
    if (state.messageId === undefined) {
      state.messageId = await this.messagePort.sendCard(chatId, card, signal);
    } else {
      await this.messagePort.updateCard(state.messageId, card, signal);
    }
    state.fingerprint = presentation.fingerprint;
  }

  private deliverReasoning(
    event: Extract<OutputEvent, { type: "turn.reasoning" }>,
    generation: number,
  ): void {
    const rendered = renderFeishuOutput(
      event,
      this.options.debugEnabled ?? false,
      this.options.autoCompactPercent,
    );
    if (rendered === null) {
      return;
    }
    const chatId = event.target.conversationId;
    const existing = this.reasoningCards.get(event.threadId);
    if (existing !== undefined && (existing.turnId !== event.turnId || existing.chatId !== event.target.conversationId)) {
      this.reasoningCards.delete(event.threadId);
      this.deliverReasoning(event, generation);
      return;
    }
    if (existing === undefined) {
      if (event.final === true) {
        this.delivery.enqueue(
          chatId,
          (signal) => (this.reasoningGenerations.get(turnKey(event.threadId, event.turnId)) ?? 0) !== generation
            || this.hasActiveOperation(event.threadId, event.turnId)
            ? Promise.resolve()
            : this.sendMarkdown(chatId, rendered, maximumFeishuMessageChunks, undefined, undefined, signal),
          true,
        );
        return;
      }
      const state: FeishuReasoningCard = {
        chatId,
        threadId: event.threadId,
        turnId: event.turnId,
        segment: this.nextReasoningSegment++,
        sequence: 0,
      };
      this.reasoningCards.set(event.threadId, state);
      this.delivery.enqueue(
        chatId,
        async (signal) => {
          if ((this.reasoningGenerations.get(turnKey(event.threadId, event.turnId)) ?? 0) !== generation
            || this.hasActiveOperation(event.threadId, event.turnId)) {
            if (this.reasoningCards.get(event.threadId) === state) {
              this.reasoningCards.delete(event.threadId);
            }
            return;
          }
          try {
            const created = await this.messagePort.createStreamingCard(chatId, rendered, signal);
            state.cardId = created.cardId;
            state.lastText = rendered;
            this.logger.info(
              {
                component: "Feishu",
                threadId: event.threadId,
                turnId: event.turnId,
                cardId: created.cardId,
              },
              "飞书思考流式卡已创建",
            );
          } catch (error) {
            if (this.reasoningCards.get(event.threadId) === state) {
              this.reasoningCards.delete(event.threadId);
            }
            this.logger.warn(
              {
                ...surfaceDiagnosticContext(),
                component: "Feishu",
                threadId: event.threadId,
                turnId: event.turnId,
                ...surfaceErrorMetadata(error),
              },
              "飞书思考流式卡创建失败，回退普通卡片",
            );
            await this.sendMarkdown(chatId, rendered, maximumFeishuMessageChunks, undefined, undefined, signal);
            throw error;
          }
        },
        true,
      );
      return;
    }
    if (event.final === true) {
      this.reasoningCards.delete(event.threadId);
    }
    const coalesceKey = surfaceDeliveryCoalesceKey(event, existing.segment);
    this.delivery.enqueue(
      chatId,
      async (signal) => {
        if ((this.reasoningGenerations.get(turnKey(event.threadId, event.turnId)) ?? 0) !== generation
          || this.hasActiveOperation(event.threadId, event.turnId)) {
          return;
        }
        if (existing.cardId === undefined) {
          if (this.reasoningCards.get(event.threadId) === existing) {
            this.reasoningCards.delete(event.threadId);
          }
          await this.sendMarkdown(chatId, rendered, maximumFeishuMessageChunks, undefined, undefined, signal);
          return;
        }
        existing.sequence += 1;
        existing.lastText = rendered;
        try {
          if (event.final === true) {
            await this.messagePort.updateStreamingCard(
              existing.cardId,
              rendered,
              existing.sequence,
              signal,
            );
            existing.sequence += 1;
            await this.messagePort.finishStreamingCard(
              existing.cardId,
              existing.sequence,
              rendered,
              undefined,
              signal,
            );
            this.logger.info(
              {
                component: "Feishu",
                threadId: event.threadId,
                turnId: event.turnId,
                cardId: existing.cardId,
              },
              "飞书思考流式卡已结束",
            );
            return;
          }
          await this.messagePort.updateStreamingCard(
            existing.cardId,
            rendered,
            existing.sequence,
            signal,
          );
        } catch (error) {
          if (this.reasoningCards.get(event.threadId) === existing) {
            this.reasoningCards.delete(event.threadId);
          }
          this.logger.warn(
            {
              ...surfaceDiagnosticContext(),
              component: "Feishu",
              threadId: event.threadId,
              turnId: event.turnId,
              final: event.final === true,
              ...surfaceErrorMetadata(error),
            },
            "飞书思考流式卡更新失败，回退普通卡片",
          );
          await this.sendMarkdown(chatId, rendered, maximumFeishuMessageChunks, undefined, undefined, signal);
          throw error;
        }
      },
      true,
      coalesceKey === undefined ? undefined : { coalesceKey },
    );
  }

  private async sendImage(
    chatId: string,
    imagePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.messagePort.sendImage === undefined) {
      throw new FeishuMessageError(
        "invalid-response",
        "飞书图片发送能力不可用",
      );
    }
    const image = await (
      this.options.readGeneratedImage ?? readGeneratedImage
    )(imagePath);
    await this.messagePort.sendImage(chatId, image.bytes, signal);
  }

  sendChannelImage(chatId: string, imagePath: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.sendImage(chatId, imagePath, signal),
    );
  }

  prepareTurnReplyTarget(chatId: string, messageId: string): void {
    if (!this.closed) {
      this.replyTargets.prepare(chatId, messageId);
    }
  }

  bindPendingTurnReplyTarget(
    chatId: string,
    threadId: string,
    turnId: string,
  ): void {
    if (!this.closed) {
      this.replyTargets.bindPending(chatId, turnKey(threadId, turnId));
    }
  }

  discardPendingTurnReplyTarget(chatId: string): void {
    this.replyTargets.discardPending(chatId);
  }

  notifyText(chatId: string, text: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      (signal) => this.sendText(chatId, text, signal),
      true,
    );
  }

  notifyMarkdown(chatId: string, markdown: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      (signal) => this.sendMarkdown(chatId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal),
      true,
    );
  }

  replyMarkdown(chatId: string, messageId: string, markdown: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      (signal) => this.sendMarkdown(chatId, markdown, maximumFeishuMessageChunks, messageId, undefined, signal),
      true,
    );
  }

  replyToTurn(chatId: string, threadId: string, turnId: string, markdown: string): boolean {
    const replyTo = this.replyTargets.get(chatId, turnKey(threadId, turnId));
    if (replyTo === undefined) return false;
    return this.replyMarkdown(chatId, replyTo, markdown);
  }

  deliverText(chatId: string, text: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.sendText(chatId, text, signal),
    );
  }

  deliverMarkdown(chatId: string, markdown: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.sendMarkdown(chatId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal),
    );
  }

  deliverCard(
    chatId: string,
    card: FeishuCardDocument,
    requestSignal?: AbortSignal,
    observeCreation?: ObserveFeishuCardCreation,
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.messagePort.sendCard(chatId, card, signal, observeCreation),
      requestSignal,
    );
  }

  updateCard(
    chatId: string,
    messageId: string,
    card: FeishuCardDocument,
    requestSignal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.messagePort.updateCard(messageId, card, signal),
      requestSignal,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { target, summary } of this.operationUpdates.drain()) {
      this.enqueueOperationSummary(target, summary);
    }
    this.textStreams.prepareClose();
    await this.delivery.close();
    this.closeFinished = true;
    this.deliveryAbort.abort();
    this.threadStatusMessages.clear();
    this.planMessages.clear();
    this.textStreams.clear();
    this.reasoningCards.clear();
    this.activeOperations.clear();
    this.reasoningGenerations.clear();
    this.operationDisplays.clear();
    this.computerUseCards.clear();
    this.pendingApprovalOperations.clear();
    this.heldApprovalOperations.clear();
    this.operationUpdates.clear();
    this.replyTargets.clear();
  }

  private flushOperationUpdates(
    chatId: string,
    event: Extract<OutputEvent, { type: "text.completed" | "turn.completed" }>,
  ): void {
    const buffered = this.operationUpdates.flush(event);
    if (buffered === null) {
      return;
    }
    this.enqueueOperationSummary(chatId, buffered.summary);
  }

  private enqueueOperationSummary(
    chatId: string,
    summary: OperationUpdateSummary,
  ): void {
    const markdown = formatFeishuOperationSummary(
      summary,
      this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
    );
    this.delivery.enqueue(
      chatId,
      (signal) => this.sendMarkdown(chatId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal),
      true,
    );
  }

  private clearExecutionTurns(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.activeOperations) {
      if (key.startsWith(prefix)) this.activeOperations.delete(key);
    }
    for (const key of this.reasoningGenerations.keys()) {
      if (key.startsWith(prefix)) this.reasoningGenerations.delete(key);
    }
    for (const key of this.operationDisplays.keys()) {
      if (key.startsWith(prefix)) this.operationDisplays.delete(key);
    }
    for (const key of this.computerUseCards.keys()) {
      if (key.startsWith(prefix)) this.computerUseCards.delete(key);
    }
  }

  private operationKey(threadId: string, turnId: string, itemId: string): string {
    return `${turnKey(threadId, turnId)}\u0000${itemId}`;
  }


  private acceptOperationDisplay(
    event: Extract<OutputEvent, { type: "operation.updated" }>,
    markdown: string,
  ): boolean {
    const key = this.operationKey(event.threadId, event.turnId, event.operation.itemId);
    const receipt = DeliveryReceipt.current();
    const displayed = this.operationDisplays.get(key);
    if ((!receipt || receipt.transient) && displayed?.chatId === event.target.conversationId && displayed.markdown === markdown) {
      return false;
    }
    this.operationDisplays.set(key, { chatId: event.target.conversationId, markdown });
    return true;
  }


  prepareInteraction(request: InteractionRequest): void {
    if (request.type !== "approval") return;
    this.pendingApprovalOperations.add(
      this.operationKey(request.threadId, request.turnId, request.itemId),
    );
  }

  finishInteraction(request: InteractionRequest, decision: InteractionDecision): void {
    if (request.type !== "approval") return;
    const key = this.operationKey(request.threadId, request.turnId, request.itemId);
    this.pendingApprovalOperations.delete(key);
    const held = this.heldApprovalOperations.get(key);
    this.heldApprovalOperations.delete(key);
    if (!held || decision.type !== "approval" || !decision.approved) return;
    void held;
  }


  private sealReasoningCard(chatId: string, threadId: string, turnId: string): void {
    const state = this.reasoningCards.get(threadId);
    if (state === undefined || state.turnId !== turnId || state.chatId !== chatId) {
      return;
    }
    this.reasoningCards.delete(threadId);
    if (state.cardId === undefined || state.lastText === undefined) {
      return;
    }
    state.sequence += 1;
    this.delivery.enqueue(
      state.chatId,
      async (signal) => {
        await this.messagePort.finishStreamingCard(
          state.cardId!,
          state.sequence,
          state.lastText!.replace(/^思考中…/u, "思考完成"),
          undefined,
          signal,
        );
      },
      true,
    );
  }

  private hasActiveOperation(threadId: string, turnId: string): boolean {
    const prefix = `${turnKey(threadId, turnId)}\u0000`;
    return [...this.activeOperations].some((key) => key.startsWith(prefix));
  }

  private async sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    for (const chunk of splitFeishuText(text)) {
      await this.messagePort.sendText(chatId, chunk, signal);
    }
  }

  private async sendPost(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
    signal?: AbortSignal,
    replyTo?: string,
    truncationNotice?: string,
  ): Promise<number> {
    const chunks = splitFeishuPost(markdown, maximumChunks, truncationNotice);
    for (const [index, chunk] of chunks.entries()) {
      if (index === 0 && replyTo !== undefined && this.messagePort.replyPost) {
        await this.messagePort.replyPost(replyTo, chunk, signal);
      } else {
        await this.messagePort.sendPost(chatId, chunk, signal);
      }
    }
    return chunks.length;
  }

  private async sendMarkdown(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
    replyTo?: string,
    onFirstMessageId?: (messageId: string) => void,
    signal?: AbortSignal,
    truncationNotice?: string,
  ): Promise<void> {
    let first = true;
    let remainingBudget = maximumChunks;
    const chunks = splitFeishuMarkdownCards(markdown, maximumChunks, truncationNotice);
    for (const [index, chunk] of chunks.entries()) {
      try {
        if (first && replyTo !== undefined && this.messagePort.replyMarkdownCard) {
          const messageId = await this.messagePort.replyMarkdownCard(replyTo, chunk, signal);
          if (typeof messageId === "string") {
            onFirstMessageId?.(messageId);
          }
        } else {
          const messageId = await this.messagePort.sendMarkdownCard(chatId, chunk, signal);
          if (first && typeof messageId === "string") {
            onFirstMessageId?.(messageId);
          }
        }
      } catch (error) {
        if (
          !(error instanceof FeishuMessageError)
          || error.code !== "card-create-failed"
        ) {
          throw error;
        }
        this.logger.warn(
          {
            ...surfaceDiagnosticContext(),
            component: "Feishu",
            fallback: "post",
          },
          "飞书静态 CardKit 创建失败，已降级为富文本",
        );
        // Card limits count characters; Post limits count encoded bytes.
        // Reserve one slot for each later card and share the same total budget.
        remainingBudget -= await this.sendPost(
          chatId, chunk, remainingBudget - (chunks.length - index - 1),
          signal, first ? replyTo : undefined, truncationNotice,
        );
        first = false;
        continue;
      }
      remainingBudget--;
      first = false;
    }
  }

  private async sendTurnMarkdown(
    event: Extract<
      OutputEvent,
      { type: "turn.started" | "text.completed" | "turn.completed" }
    >,
    markdown: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (event.type === "turn.started") {
      const current = this.threadStatusMessages.get(event.threadId);
      this.logger.info(
        {
          component: "Feishu",
          threadId: event.threadId,
          turnId: event.turnId,
          hasCurrent: current !== undefined,
        },
        "飞书 Turn 开始状态卡检查",
      );
      if (current?.chatId === event.target.conversationId) {
        try {
          const activeCard = renderFeishuThreadStatusCard(
            "active",
            event.identity ?? current.identity,
          );
          if (signal) {
            await this.messagePort.updateCard(current.messageId, activeCard, signal);
          } else {
            await this.messagePort.updateCard(current.messageId, activeCard);
          }
          this.logger.info(
            {
              component: "Feishu",
              threadId: event.threadId,
              turnId: event.turnId,
              messageId: current.messageId,
            },
            "飞书状态卡已刷新为运行中",
          );
        } catch (error) {
          this.logger.warn(
            {
              ...surfaceDiagnosticContext(),
              component: "Feishu",
              threadId: event.threadId,
              turnId: event.turnId,
              ...surfaceErrorMetadata(error),
            },
            "飞书状态卡刷新失败",
          );
          if (this.threadStatusMessages.get(event.threadId) === current) {
            this.threadStatusMessages.delete(event.threadId);
          }
          throw error;
        }
        this.threadStatusMessages.set(event.threadId, {
          ...current,
          status: "active",
          ...(event.identity ? { identity: event.identity } : {}),
        });
        const replyTo = this.replyTargets.get(
          event.target.conversationId, turnKey(event.threadId, event.turnId),
        );
        if (replyTo !== undefined) {
          await this.sendMarkdown(
            event.target.conversationId,
            markdown,
            maximumFeishuMessageChunks,
            replyTo,
            undefined,
            signal,
          );
        }
        return;
      }
      const replyTo = this.replyTargets.get(
        event.target.conversationId, turnKey(event.threadId, event.turnId),
      );
      if (replyTo !== undefined) {
        await this.sendMarkdown(
          event.target.conversationId,
          markdown,
          maximumFeishuMessageChunks,
          replyTo,
          undefined,
          signal,
        );
      }
      if (event.background === true) {
        return;
      }
      const messageId = await this.messagePort.sendCard(
        event.target.conversationId,
        renderFeishuThreadStatusCard("active", event.identity),
        signal,
      );
      this.logger.info(
        {
          component: "Feishu",
          threadId: event.threadId,
          turnId: event.turnId,
          messageId,
        },
        "飞书状态卡已创建",
      );
      if (!this.closeFinished) {
        this.threadStatusMessages.set(event.threadId, {
          chatId: event.target.conversationId,
          messageId,
          status: "active",
          ...(event.identity ? { identity: event.identity } : {}),
        });
      }
      return;
    }
    const key = turnKey(event.threadId, event.turnId);
    const replyTo = this.replyTargets.get(event.target.conversationId, key);
    if (
      event.type === "text.completed"
      && (event.phase !== "commentary" || DeliveryReceipt.current() !== undefined)
      && this.canSendCompletedAnswerFile(event.text)
    ) {
      await this.sendLongFinalAnswer(
        event.target.conversationId,
        event.text,
        replyTo,
        signal,
      );
      return;
    }
    try {
      await this.sendMarkdown(
        event.target.conversationId,
        markdown,
        maximumFeishuMessageChunks,
        replyTo,
        undefined,
        signal,
        event.type === "text.completed" && DeliveryReceipt.current() && this.canSendCompleteContentFile(event.text)
          ? feishuPreviewNotice : undefined,
      );
    } finally {
      if (event.type === "turn.completed") {
        this.replyTargets.delete(event.target.conversationId, key);
      }
    }
  }

  private enqueueCompletedAnswerFile(
    event: Extract<OutputEvent, { type: "text.completed" }>,
  ): void {
    if (
      event.phase === "commentary"
      || !this.canSendCompletedAnswerFile(event.text)
    ) {
      return;
    }
    const file = Buffer.from(event.text, "utf8");
    this.delivery.enqueue(
      event.target.conversationId,
      async (signal) => {
        try {
          await this.messagePort.sendFile!(
            event.target.conversationId,
            feishuFinalAnswerFileName,
            file,
            signal,
          );
          DeliveryReceipt.current()?.confirmCompleteContent();
        } catch (error) {
          await this.sendText(
            event.target.conversationId,
            "[完整文件发送失败，当前卡片仅包含有界预览]",
            signal,
          );
          throw error;
        }
      },
      true,
    );
  }

  private canSendCompletedAnswerFile(text: string): boolean {
    if (
      this.messagePort.sendFile === undefined
      || [...text].length
        <= maximumFeishuStreamingElementCharacters
          * maximumFeishuStreamingCards
    ) {
      return false;
    }
    return this.canSendCompleteContentFile(text);
  }

  private canSendCompleteContentFile(text: string): boolean {
    if (!this.messagePort.sendFile) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes > 0 && bytes <= maximumFeishuFinalAnswerFileBytes;
  }

  private async sendCompleteContentFile(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    const file = Buffer.from(text, "utf8");
    if (!this.messagePort.sendFile || file.length > maximumFeishuFinalAnswerFileBytes) {
      throw new Error("可靠结果无法通过完整文件确认");
    }
    await this.messagePort.sendFile(chatId, feishuFinalAnswerFileName, file, signal);
    DeliveryReceipt.current()?.confirmCompleteContent();
  }

  private async sendLongFinalAnswer(
    chatId: string,
    text: string,
    replyTo?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const maximumPreviewCharacters =
      maximumFeishuFinalPreviewCharacters
      - [...feishuPreviewNotice].length;
    const [head, tail] = splitFeishuStreamingContent(
      text,
      maximumPreviewCharacters,
    );
    await this.sendMarkdown(
      chatId,
      `${head}${feishuPreviewNotice}`,
      1,
      replyTo,
      undefined,
      signal,
    );
    try {
      await this.sendCompleteContentFile(chatId, text, signal);
    } catch (error) {
      await this.sendMarkdown(
        chatId,
        `${feishuFileFailureNotice}${tail}`,
        maximumFeishuMessageChunks - 1,
        undefined,
        undefined,
        signal,
      );
      throw error;
    }
  }

  private async deliverThreadStatus(
    event: Extract<OutputEvent, { type: "thread.status" }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = this.threadStatusMessages.get(event.threadId);
    const card = renderFeishuThreadStatusCard(event.status, current?.identity);
    if (
      current
      && current.chatId === event.target.conversationId
    ) {
      if (current.status === event.status) {
        this.logger.info(
          {
            component: "Feishu",
            threadId: event.threadId,
            status: event.status,
          },
          "飞书状态卡状态未变化，跳过更新",
        );
        return;
      }
      try {
        if (signal) {
          await this.messagePort.updateCard(current.messageId, card, signal);
        } else {
          await this.messagePort.updateCard(current.messageId, card);
        }
        this.logger.info(
          {
            component: "Feishu",
            threadId: event.threadId,
            status: event.status,
          },
          "飞书状态卡已原地更新",
        );
      } catch (error) {
        if (signal?.aborted) {
          if (this.threadStatusMessages.get(event.threadId) === current) this.threadStatusMessages.delete(event.threadId);
          throw error;
        }
        this.logger.warn(
          {
            ...surfaceDiagnosticContext(),
            component: "Feishu",
            threadId: event.threadId,
            status: event.status,
            ...surfaceErrorMetadata(error),
          },
          "飞书状态卡更新失败，改为重建",
        );
        try {
          const messageId = await this.messagePort.sendCard(
            event.target.conversationId,
            card,
            signal,
          );
          if (event.status === "active" && !this.closeFinished) {
            this.threadStatusMessages.set(event.threadId, {
              chatId: event.target.conversationId,
              messageId,
              status: event.status,
            });
          } else {
            this.threadStatusMessages.delete(event.threadId);
          }
          return;
        } catch (fallbackError) {
          if (this.threadStatusMessages.get(event.threadId) === current) {
            this.threadStatusMessages.delete(event.threadId);
          }
          throw fallbackError;
        }
      }
      if (event.status === "active" && !this.closeFinished) {
        this.threadStatusMessages.set(event.threadId, {
          ...current,
          status: event.status,
        });
      } else {
        this.threadStatusMessages.delete(event.threadId);
      }
      return;
    }
    if (event.status !== "active") {
      return;
    }
    const messageId = await this.messagePort.sendCard(
      event.target.conversationId,
      card,
      signal,
    );
    this.logger.info(
      {
        component: "Feishu",
        threadId: event.threadId,
        status: event.status,
        messageId,
      },
      "飞书状态卡已创建",
    );
    if (event.status === "active" && !this.closeFinished) {
      this.threadStatusMessages.set(event.threadId, {
        chatId: event.target.conversationId,
        messageId,
        status: event.status,
      });
    }
  }


}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}
