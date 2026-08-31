import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type OutputEvent,
  type TurnStartIdentity,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
  ProviderModelUsageEstimate,
} from "../../application/index.js";
import { readGeneratedImage } from "../generated-image.js";
import {
  OperationUpdateBuffer,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";
import { isExecutionOperation, shouldDisplayOperation } from "../operation-presentation.js";
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
import { FeishuMessageError } from "./client.js";
import {
  formatFeishuOperation,
  formatFeishuOperationSummary,
} from "./operation-format.js";
import {
  appendBoundedStreamText,
  appendFeishuStreamingTruncation,
  boundedStreamText,
  feishuTruncationNotice,
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

const feishuStreamFlushDelayMs = 300;
const maximumFeishuActiveStreams = 100;
const maximumFeishuFinishedStreams = 100;
const maximumFeishuFinalAnswerFileBytes = 1_000_000;
const feishuFinalAnswerFileName = "codex-final-answer.txt";
const feishuPreviewNotice = "\n\n[内容预览，完整回复见附件]";
const feishuFileFailureNotice = "[完整文件发送失败，已改为分段文本]\n\n";

interface FeishuStreamState {
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  phase?: "commentary" | "final_answer" | null;
  text: string;
  cardText: string;
  truncated: boolean;
  sequence: number;
  cardCount: number;
  cardId?: string;
  lastSentText?: string;
  timer?: NodeJS.Timeout;
  failed: boolean;
  completionFooter?: string;
}

interface FinishedFeishuStream {
  chatId: string;
  cardId: string;
  sequence: number;
  summary: string;
}

interface FeishuPlanState {
  messageId?: string;
  fingerprint?: string;
}

interface FeishuReasoningCard {
  chatId: string;
  threadId: string;
  turnId: string;
  cardId?: string;
  sequence: number;
  lastText?: string;
}

export interface FeishuMessagePort {
  sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void>;
  sendPost(chatId: string, markdown: string, signal?: AbortSignal): Promise<void>;
  sendMarkdownCard(chatId: string, markdown: string, signal?: AbortSignal): Promise<string | void>;
  sendFile?(chatId: string, fileName: string, file: Buffer, signal?: AbortSignal): Promise<void>;
  sendImage?(chatId: string, image: Buffer, signal?: AbortSignal): Promise<void>;
  replyPost?(messageId: string, markdown: string, signal?: AbortSignal): Promise<void>;
  replyMarkdownCard?(messageId: string, markdown: string, signal?: AbortSignal): Promise<string | void>;
  sendCard(chatId: string, card: FeishuCardDocument, signal?: AbortSignal): Promise<string>;
  updateCard(messageId: string, card: FeishuCardDocument, signal?: AbortSignal): Promise<void>;
  createStreamingCard(
    chatId: string,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<{ cardId: string; messageId: string }>;
  createStreamingReplyCard?(
    messageId: string,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<{ cardId: string; messageId: string }>;
  updateStreamingCard(
    cardId: string,
    content: string,
    sequence: number,
    signal?: AbortSignal,
  ): Promise<void>;
  finishStreamingCard(
    cardId: string,
    sequence: number,
    summary: string,
    footer?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface FeishuOutboxOptions {
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  reasoningEnabled?: boolean;
  readGeneratedImage?: typeof readGeneratedImage;
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
}

export class FeishuOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
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
  private readonly streams = new Map<string, FeishuStreamState>();
  private readonly finishedStreams = new Map<string, FinishedFeishuStream>();
  private readonly reasoningCards = new Map<string, FeishuReasoningCard>();
  private readonly activeOperations = new Set<string>();
  private readonly reasoningGenerations = new Map<string, number>();
  private readonly operationDisplays = new Map<string, string>();
  private readonly pendingApprovalOperations = new Set<string>();
  private readonly heldApprovalOperations = new Map<string, Extract<OutputEvent, { type: "operation.updated" }>['operation']>();
  private readonly operationUpdates = new OperationUpdateBuffer<string>();
  private readonly replyTargets = new TurnReplyTargets<string>();
  private streamCapacityWarningIssued = false;
  private closed = false;
  private closeFinished = false;

  constructor(
    private readonly accountId: string,
    private readonly messagePort: FeishuMessagePort,
    private readonly logger: Logger,
    private readonly options: FeishuOutboxOptions = {},
  ) {
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Feishu",
    });
  }

  async handle(event: OutputEvent): Promise<void> {
    if (
      this.closed
      || event.target.surface !== "feishu"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    if (event.type === "text.delta") {
      this.acceptStreamDelta(event);
      return;
    }
    if (event.type === "turn.started") {
      this.clearExecutionTurns(event.threadId);
      this.reasoningCards.delete(event.threadId);
      this.replyTargets.bindPending(
        event.target.conversationId,
        turnKey(event.threadId, event.turnId),
      );
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
      if (this.completeStream(event)) {
        this.enqueueCompletedAnswerFile(event);
        return;
      }
    }
    if (event.type === "operation.updated") {
      if (isExecutionOperation(event.operation)) {
        const turn = turnKey(event.threadId, event.turnId);
        const key = this.operationKey(event.threadId, event.turnId, event.operation.itemId);
        if (event.operation.status === "running") {
          this.activeOperations.add(key);
          this.reasoningGenerations.set(turn, (this.reasoningGenerations.get(turn) ?? 0) + 1);
          this.sealReasoningCard(event.threadId, event.turnId);
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
        this.flushStreamsBeforeVisibleOutput(event.threadId, event.turnId);
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
        return;
      } else {
        if (event.operation.kind === "command") {
          flushStreamBeforeOutput();
        }
        flushStreamBeforeOutput();
        const markdown = formatFeishuOperation(event.operation, this.options.operationUpdateDisplay === "compact" ? "compact" : "full");
        if (!this.acceptOperationDisplay(event, markdown)) return;
        this.delivery.enqueue(event.target.conversationId, (signal) => this.sendMarkdown(event.target.conversationId, markdown, maximumFeishuMessageChunks, undefined, undefined, signal), true);
      }
      return;
    }
    if (event.type === "plan.updated") {
      if (!this.options.planUpdatesEnabled) {
        return;
      }
      const key = turnKey(event.threadId, event.turnId);
      const state = this.planMessages.get(key) ?? {};
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
      this.flushOperationUpdates(event.target.conversationId, event);
      const remainingUsage = event.model && this.options.remainingUsage
        ? (await this.options.remainingUsage?.(
            event.model,
            event.timing?.modelRequestStartedAtMs,
            event.modelProvider,
          )) ?? null
        : null;
      const completion = renderFeishuOutput(
        event,
        this.options.priceCurrency,
        this.options.exchangeRate?.() ?? null,
        this.options.debugEnabled ?? false,
        remainingUsage,
      );
      if (
        completion !== null
        && this.finishStreamsForTurn(event.threadId, event.turnId, completion)
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
    const rendered = renderFeishuOutput(
      event,
      this.options.priceCurrency,
      this.options.exchangeRate?.() ?? null,
      this.options.debugEnabled ?? false,
    );
    if (rendered === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      (signal) => event.type === "subagent.spawned"
          || event.type === "subagent.contacted"
          || event.type === "subagent.completed"
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
      this.options.priceCurrency,
      this.options.exchangeRate?.() ?? null,
      this.options.debugEnabled ?? false,
    );
    if (rendered === null) {
      return;
    }
    const chatId = event.target.conversationId;
    const existing = this.reasoningCards.get(event.threadId);
    if (existing !== undefined && existing.turnId !== event.turnId) {
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
    const replyTo = this.replyTargets.get(turnKey(threadId, turnId));
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
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.messagePort.sendCard(chatId, card, signal),
    );
  }

  updateCard(
    chatId: string,
    messageId: string,
    card: FeishuCardDocument,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      (signal) => this.messagePort.updateCard(messageId, card, signal),
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
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        () => this.flushStream(key, true, false),
        true,
      );
    }
    await this.delivery.close();
    this.closeFinished = true;
    this.threadStatusMessages.clear();
    this.planMessages.clear();
    this.streams.clear();
    this.finishedStreams.clear();
    this.reasoningCards.clear();
    this.activeOperations.clear();
    this.reasoningGenerations.clear();
    this.operationDisplays.clear();
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
    const prefix = `${threadId}\u0000`;
    for (const key of this.activeOperations) {
      if (key.startsWith(prefix)) this.activeOperations.delete(key);
    }
    for (const key of this.reasoningGenerations.keys()) {
      if (key.startsWith(prefix)) this.reasoningGenerations.delete(key);
    }
    for (const key of this.operationDisplays.keys()) {
      if (key.startsWith(prefix)) this.operationDisplays.delete(key);
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
    if (this.operationDisplays.get(key) === markdown) {
      return false;
    }
    this.operationDisplays.set(key, markdown);
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


  private sealReasoningCard(threadId: string, turnId: string): void {
    const state = this.reasoningCards.get(threadId);
    if (state === undefined || state.turnId !== turnId) {
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
    signal = this.closed ? undefined : signal;
    for (const chunk of splitFeishuText(text)) {
      await this.messagePort.sendText(chatId, chunk, signal);
    }
  }

  private async sendPost(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
    signal?: AbortSignal,
  ): Promise<void> {
    signal = this.closed ? undefined : signal;
    for (const chunk of splitFeishuPost(markdown, maximumChunks)) {
      await this.messagePort.sendPost(chatId, chunk, signal);
    }
  }

  private async sendMarkdown(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
    replyTo?: string,
    onFirstMessageId?: (messageId: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    signal = this.closed ? undefined : signal;
    let first = true;
    for (const chunk of splitFeishuMarkdownCards(markdown, maximumChunks)) {
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
            component: "Feishu",
            fallback: "post",
          },
          "飞书静态 CardKit 创建失败，已降级为富文本",
        );
        if (first && replyTo !== undefined && this.messagePort.replyPost) {
          await this.messagePort.replyPost(replyTo, chunk, signal);
        } else {
          await this.sendPost(chatId, chunk, 1, signal);
        }
      }
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
    signal = this.closed ? undefined : signal;
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
          turnKey(event.threadId, event.turnId),
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
        turnKey(event.threadId, event.turnId),
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
    const replyTo = this.replyTargets.get(key);
    if (
      event.type === "text.completed"
      && event.phase !== "commentary"
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
      );
    } finally {
      if (event.type === "turn.completed") {
        this.replyTargets.delete(key);
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
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes > 0 && bytes <= maximumFeishuFinalAnswerFileBytes;
  }

  private async sendLongFinalAnswer(
    chatId: string,
    text: string,
    replyTo?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const maximumPreviewCharacters =
      maximumFeishuStreamingElementCharacters
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
      await this.messagePort.sendFile!(
        chatId,
        feishuFinalAnswerFileName,
        Buffer.from(text, "utf8"),
        signal,
      );
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
    signal = this.closed ? undefined : signal;
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
        this.logger.warn(
          {
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

  private acceptStreamDelta(
    event: Extract<OutputEvent, { type: "text.delta" }>,
  ): void {
    const key = streamKey(event.threadId, event.turnId, event.itemId);
    const existing = this.streams.get(key);
    if (!existing && this.streams.size >= maximumFeishuActiveStreams) {
      if (!this.streamCapacityWarningIssued) {
        this.streamCapacityWarningIssued = true;
        this.logger.warn(
          {
            component: "Feishu",
            maximumActiveStreams: maximumFeishuActiveStreams,
          },
          "飞书活动流状态已满，当前非关键增量未接收",
        );
      }
      return;
    }
    if (this.streams.size < maximumFeishuActiveStreams) {
      this.streamCapacityWarningIssued = false;
    }
    const state = existing ?? {
      chatId: event.target.conversationId,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      ...(event.phase === undefined ? {} : { phase: event.phase }),
      text: "",
      cardText: "",
      truncated: false,
      sequence: 0,
      cardCount: 0,
      failed: false,
    };
    if (event.phase !== undefined) {
      state.phase = event.phase;
    }
    const previousText = state.text;
    const appended = appendBoundedStreamText(state.text, event.text);
    state.text = appended.text;
    state.truncated ||= appended.truncated;
    state.cardText = appendBoundedStreamText(
      state.cardText,
      state.text.slice(previousText.length),
    ).text;
    this.streams.set(key, state);
    if (!state.timer) {
      state.timer = setTimeout(() => {
        delete state.timer;
        this.delivery.enqueue(
          state.chatId,
          (signal) => this.flushStream(key, false, false, signal),
          false,
        );
      }, feishuStreamFlushDelayMs);
      state.timer.unref();
    }
  }

  private completeStream(
    event: Extract<OutputEvent, { type: "text.completed" }>,
  ): boolean {
    const key = streamKey(event.threadId, event.turnId, event.itemId);
    const state = this.streams.get(key);
    if (!state) {
      return false;
    }
    const bounded = boundedStreamText(event.text);
    if (event.phase !== undefined) {
      state.phase = event.phase;
    }
    const completedText = bounded.text;
    state.truncated = bounded.truncated;
    if (completedText.startsWith(state.text)) {
      state.cardText = appendBoundedStreamText(
        state.cardText,
        completedText.slice(state.text.length),
      ).text;
    } else if (state.cardCount <= 1) {
      state.cardText = completedText;
    } else {
      state.failed = true;
    }
    state.text = completedText;
    if (state.timer) {
      clearTimeout(state.timer);
      delete state.timer;
    }
    this.delivery.enqueue(
      state.chatId,
      (signal) => this.flushStream(key, true, true, signal),
      true,
    );
    return true;
  }

  private flushStreamsBeforeVisibleOutput(
    threadId: string,
    turnId: string,
  ): void {
    for (const [key, state] of this.streams) {
      if (state.threadId !== threadId || state.turnId !== turnId) {
        continue;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        (signal) => this.flushStream(key, false, false, signal),
        true,
      );
    }
  }

  private finishStreamsForTurn(
    threadId: string,
    turnId: string,
    footer: string,
  ): boolean {
    const matching = [...this.streams].filter(([, state]) =>
      state.threadId === threadId && state.turnId === turnId
    );
    const footerTarget = matching.findLast(([, state]) =>
      state.phase !== "commentary"
    );
    for (const [key, state] of matching) {
      if (footerTarget?.[0] === key) {
        state.completionFooter = footer;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        (signal) => this.flushStream(key, true, true, signal),
        true,
      );
    }
    if (footerTarget !== undefined) {
      return true;
    }
    const key = turnKey(threadId, turnId);
    const completed = this.finishedStreams.get(key);
    if (!completed) {
      return false;
    }
    this.finishedStreams.delete(key);
    this.delivery.enqueue(
      completed.chatId,
      async (signal) => {
        try {
          await this.messagePort.finishStreamingCard(
            completed.cardId,
            completed.sequence + 1,
            completed.summary,
            footer,
            signal,
          );
        } catch (error) {
          await this.sendMarkdown(completed.chatId, footer, maximumFeishuMessageChunks, undefined, undefined, signal);
          throw error;
        }
      },
      true,
    );
    return true;
  }

  private async flushStream(
    key: string,
    terminal: boolean,
    fallbackPost: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    signal = this.closed ? undefined : signal;
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    if (state.failed) {
      if (terminal && !signal?.aborted) {
        await this.recoverFailedStream(key, state, fallbackPost);
      }
      return;
    }
    if (!state.cardId && terminal) {
      this.streams.delete(key);
      const remainingMessageBudget =
        maximumFeishuMessageChunks - state.cardCount;
      if (fallbackPost && remainingMessageBudget > 0) {
        const markdown = state.truncated
          ? `${state.cardText}${feishuTruncationNotice}`
          : state.cardText;
        const replyKey = turnKey(state.threadId, state.turnId);
        const replyTo = this.replyTargets.get(replyKey);
        await this.sendMarkdown(
          state.chatId,
          markdown,
          remainingMessageBudget,
          replyTo,
          undefined,
        );
      }
      if (state.completionFooter !== undefined) {
        await this.sendMarkdown(state.chatId, state.completionFooter, maximumFeishuMessageChunks, undefined, undefined, signal);
      }
      return;
    }
    try {
      const ready = await this.rollStreamingCards(state, terminal, signal);
      if (!ready) {
        return;
      }
      if (state.lastSentText !== state.cardText) {
        state.sequence += 1;
        try {
          if (signal) {
            await this.messagePort.updateStreamingCard(state.cardId!, state.cardText, state.sequence, signal);
          } else {
            await this.messagePort.updateStreamingCard(state.cardId!, state.cardText, state.sequence);
          }
        } catch (error) {
          if (
            !terminal
            && error instanceof FeishuMessageError
            && error.code === "rate-limited"
          ) {
            return;
          }
          throw error;
        }
        state.lastSentText = state.cardText;
      }
    } catch (error) {
      state.failed = true;
      if (terminal && !signal?.aborted) {
        await this.recoverFailedStream(key, state, fallbackPost);
      }
      throw error;
    }
    if (terminal) {
      try {
        state.sequence += 1;
        const footerAtStart = state.completionFooter;
        if (footerAtStart === undefined) {
          await this.messagePort.finishStreamingCard(
            state.cardId!,
            state.sequence,
            state.cardText,
          );
        } else {
          await this.messagePort.finishStreamingCard(
            state.cardId!,
            state.sequence,
            state.cardText,
            footerAtStart,
          );
        }
        if (
          footerAtStart === undefined
          && state.completionFooter !== undefined
        ) {
          state.sequence += 1;
          await this.messagePort.finishStreamingCard(
            state.cardId!,
            state.sequence,
            state.cardText,
            state.completionFooter,
            signal,
          );
        }
      } catch (error) {
        this.streams.delete(key);
        if (state.completionFooter !== undefined) {
          await this.sendMarkdown(state.chatId, state.completionFooter, maximumFeishuMessageChunks, undefined, undefined, signal);
        }
        throw error;
      }
      if (state.completionFooter === undefined && state.phase !== "commentary") {
        this.rememberFinishedStream(turnKey(state.threadId, state.turnId), {
          chatId: state.chatId,
          cardId: state.cardId!,
          sequence: state.sequence,
          summary: state.cardText,
        });
      }
      this.streams.delete(key);
    }
  }

  private rememberFinishedStream(
    key: string,
    stream: FinishedFeishuStream,
  ): void {
    if (
      !this.finishedStreams.has(key)
      && this.finishedStreams.size >= maximumFeishuFinishedStreams
    ) {
      const oldest = this.finishedStreams.keys().next().value;
      if (oldest !== undefined) {
        this.finishedStreams.delete(oldest);
      }
    }
    this.finishedStreams.set(key, stream);
  }

  private async rollStreamingCards(
    state: FeishuStreamState,
    terminal: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    while (
      [...state.cardText].length > maximumFeishuStreamingElementCharacters
    ) {
      if (
        !terminal
        && !state.cardId
        && state.cardCount >= maximumFeishuStreamingCards - 1
      ) {
        return false;
      }
      const maximumCharacters = maximumFeishuStreamingElementCharacters;
      const [rawHead, tail] = splitFeishuStreamingContent(
        state.cardText,
        maximumCharacters,
      );
      const currentCardNumber = state.cardId
        ? state.cardCount
        : state.cardCount + 1;
      const reachesCardLimit =
        currentCardNumber >= maximumFeishuStreamingCards;
      const head = reachesCardLimit
        ? appendFeishuStreamingTruncation(rawHead, maximumCharacters)
        : rawHead;
      await this.ensureStreamingCard(state, head, signal);
      if (state.lastSentText !== head) {
        state.sequence += 1;
        await this.messagePort.updateStreamingCard(
          state.cardId!,
          head,
          state.sequence,
          signal,
        );
        state.lastSentText = head;
      }
      state.sequence += 1;
      await this.messagePort.finishStreamingCard(
        state.cardId!,
        state.sequence,
        head,
      );
      delete state.cardId;
      delete state.lastSentText;
      state.sequence = 0;
      state.cardText = tail;
      if (reachesCardLimit) {
        throw new Error("飞书流式卡片数量超过单个结果上限");
      }
    }
    if (
      !terminal
      && !state.cardId
      && state.cardCount >= maximumFeishuStreamingCards - 1
    ) {
      return false;
    }
    await this.ensureStreamingCard(state, state.cardText, signal);
    return true;
  }

  private async ensureStreamingCard(
    state: FeishuStreamState,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (state.cardId) {
      return;
    }
    if (state.cardCount >= maximumFeishuStreamingCards) {
      throw new Error("飞书流式卡片数量超过单个结果上限");
    }
    const replyKey = turnKey(state.threadId, state.turnId);
    const replyTo = this.replyTargets.get(replyKey);
    const created =
      replyTo !== undefined && this.messagePort.createStreamingReplyCard
        ? await this.messagePort.createStreamingReplyCard(replyTo, initialText, signal)
        : await this.messagePort.createStreamingCard(
            state.chatId,
            initialText,
          );
    state.cardId = created.cardId;
    state.lastSentText = initialText;
    state.cardCount += 1;
  }

  private async recoverFailedStream(
    key: string,
    state: FeishuStreamState,
    fallbackPost: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.streams.delete(key);
    let finishError: unknown;
    if (state.cardId) {
      state.sequence += 1;
      try {
        if (signal) {
          await this.messagePort.finishStreamingCard(state.cardId, state.sequence, state.lastSentText ?? state.cardText, undefined, signal);
        } else {
          await this.messagePort.finishStreamingCard(state.cardId, state.sequence, state.lastSentText ?? state.cardText);
        }
      } catch (error) {
        finishError = error;
      }
    }
    const remainingMessageBudget =
      maximumFeishuMessageChunks - state.cardCount;
    if (fallbackPost && remainingMessageBudget > 0) {
      const markdown = state.truncated
        ? `${state.text}${feishuTruncationNotice}`
        : state.text;
      const replyKey = turnKey(state.threadId, state.turnId);
      const replyTo = this.replyTargets.get(replyKey);
      if (replyTo !== undefined && this.messagePort.replyPost) {
        await this.messagePort.replyPost(replyTo, markdown, signal);
      } else {
        await this.sendPost(
          state.chatId,
          markdown,
          remainingMessageBudget,
          signal,
        );
      }
    }
    if (state.completionFooter !== undefined) {
          await this.sendMarkdown(state.chatId, state.completionFooter);
    }
    if (finishError) {
      throw finishError instanceof Error
        ? finishError
        : new Error("飞书流式卡片结束失败");
    }
  }
}

function streamKey(threadId: string, turnId: string, itemId: string): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}
