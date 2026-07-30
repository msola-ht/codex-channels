import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type OutputEvent,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { readGeneratedImage } from "../generated-image.js";
import {
  OperationUpdateBuffer,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";
import { contentTruncatedText } from "../output-copy.js";
import { PlanProgressTracker } from "../plan-presentation.js";
import { TurnReplyTargets } from "../turn-reply-targets.js";
import type {
  OperationUpdateDisplay,
  SurfaceOutputPort,
} from "../types.js";
import type { FeishuCardDocument } from "./approval-card.js";
import { FeishuMessageError } from "./client.js";
import { encodeFeishuPostContent } from "./message-content.js";
import {
  formatFeishuOperation,
  formatFeishuOperationSummary,
} from "./operation-format.js";
import { renderFeishuOutput } from "./renderer.js";
import {
  renderFeishuPlanCard,
  renderFeishuThreadStatusCard,
} from "./status-card.js";

const maximumFeishuMessageContentBytes = 20_000;
const maximumFeishuMessageChunks = 5;
const feishuChunkHeaderReserveBytes = 64;
const feishuTruncationNotice = `\n\n[${contentTruncatedText}]`;
const feishuStreamFlushDelayMs = 300;
const maximumFeishuStreamingElementCharacters = 5_000;
const maximumFeishuStreamingCards = 5;
const maximumFeishuActiveStreams = 100;
const maximumFeishuFinishedStreams = 100;
const maximumFeishuBufferedStreamCharacters =
  maximumFeishuStreamingElementCharacters * maximumFeishuStreamingCards + 1;
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

export interface FeishuMessagePort {
  sendText(chatId: string, text: string): Promise<void>;
  sendPost(chatId: string, markdown: string): Promise<void>;
  sendMarkdownCard(chatId: string, markdown: string): Promise<void>;
  sendFile?(chatId: string, fileName: string, file: Buffer): Promise<void>;
  sendImage?(chatId: string, image: Buffer): Promise<void>;
  replyPost?(messageId: string, markdown: string): Promise<void>;
  replyMarkdownCard?(messageId: string, markdown: string): Promise<void>;
  sendCard(chatId: string, card: FeishuCardDocument): Promise<string>;
  updateCard(messageId: string, card: FeishuCardDocument): Promise<void>;
  createStreamingCard(
    chatId: string,
    initialText: string,
  ): Promise<{ cardId: string; messageId: string }>;
  createStreamingReplyCard?(
    messageId: string,
    initialText: string,
  ): Promise<{ cardId: string; messageId: string }>;
  updateStreamingCard(
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<void>;
  finishStreamingCard(
    cardId: string,
    sequence: number,
    summary: string,
    footer?: string,
  ): Promise<void>;
}

export interface FeishuOutboxOptions {
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  readGeneratedImage?: typeof readGeneratedImage;
}

export class FeishuOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly threadStatusMessages = new Map<
    string,
    { chatId: string; messageId: string; status: string }
  >();
  private readonly planMessages = new Map<
    string,
    PlanProgressTracker
  >();
  private readonly streams = new Map<string, FeishuStreamState>();
  private readonly finishedStreams = new Map<string, FinishedFeishuStream>();
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

  handle(event: OutputEvent): void {
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
      this.replyTargets.bindPending(
        event.target.conversationId,
        turnKey(event.threadId, event.turnId),
      );
    }
    if (event.type === "text.completed") {
      if (event.phase !== "commentary") {
        this.flushOperationUpdates(
          event.target.conversationId,
          turnKey(event.threadId, event.turnId),
        );
      }
      if (this.completeStream(event)) {
        this.enqueueCompletedAnswerFile(event);
        return;
      }
    }
    if (event.type === "operation.updated") {
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
          () => this.sendGeneratedImage(
            event.target.conversationId,
            imagePath,
          ),
          true,
        );
      }
      if (this.options.operationUpdateDisplay === "hidden") {
        return;
      }
      if (
        this.operationUpdates.accept(
          turnKey(event.threadId, event.turnId),
          event.operation,
          event.target.conversationId,
        )
      ) {
        return;
      }
      if (event.operation.status !== "running") {
        flushStreamBeforeOutput();
        const markdown = formatFeishuOperation(
          event.operation,
          this.options.operationUpdateDisplay === "compact" ? "compact" : "full",
        );
        this.delivery.enqueue(
          event.target.conversationId,
          () => this.sendMarkdown(
            event.target.conversationId,
            markdown,
          ),
          true,
        );
      }
      return;
    }
    if (event.type === "plan.updated") {
      if (!this.options.planUpdatesEnabled) {
        return;
      }
      const key = turnKey(event.threadId, event.turnId);
      const tracker = this.planMessages.get(key) ?? new PlanProgressTracker();
      this.planMessages.set(key, tracker);
      for (const presentation of tracker.accept(event)) {
        this.delivery.enqueue(
          event.target.conversationId,
          () => this.messagePort.sendCard(
            event.target.conversationId,
            renderFeishuPlanCard(presentation),
          ).then(() => undefined),
          true,
        );
      }
      return;
    }
    if (event.type === "turn.completed") {
      this.planMessages.delete(turnKey(event.threadId, event.turnId));
      this.flushOperationUpdates(
        event.target.conversationId,
        turnKey(event.threadId, event.turnId),
      );
      const completion = renderFeishuOutput(event);
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
        () => this.deliverThreadStatus(event),
        true,
      );
      return;
    }
    const rendered = renderFeishuOutput(event);
    if (rendered === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      () => event.type === "turn.started"
          || event.type === "text.completed"
          || event.type === "turn.completed"
        ? this.sendTurnMarkdown(event, rendered)
        : this.sendText(event.target.conversationId, rendered),
      event.type === "turn.started" || isCriticalOutputEvent(event),
    );
  }

  private async sendGeneratedImage(
    chatId: string,
    imagePath: string,
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
    await this.messagePort.sendImage(chatId, image.bytes);
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
      () => this.sendText(chatId, text),
      true,
    );
  }

  notifyMarkdown(chatId: string, markdown: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      () => this.sendMarkdown(chatId, markdown),
      true,
    );
  }

  deliverText(chatId: string, text: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      () => this.sendText(chatId, text),
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
      () => this.messagePort.sendCard(chatId, card),
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
      () => this.messagePort.updateCard(messageId, card),
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
    this.operationUpdates.clear();
    this.replyTargets.clear();
  }

  private flushOperationUpdates(chatId: string, key: string): void {
    const buffered = this.operationUpdates.take(key);
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
      () => this.sendMarkdown(chatId, markdown),
      true,
    );
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitFeishuText(text)) {
      await this.messagePort.sendText(chatId, chunk);
    }
  }

  private async sendPost(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
  ): Promise<void> {
    for (const chunk of splitFeishuPost(markdown, maximumChunks)) {
      await this.messagePort.sendPost(chatId, chunk);
    }
  }

  private async sendMarkdown(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
    replyTo?: string,
  ): Promise<void> {
    let first = true;
    for (const chunk of splitFeishuMarkdownCards(markdown, maximumChunks)) {
      try {
        if (first && replyTo !== undefined && this.messagePort.replyMarkdownCard) {
          await this.messagePort.replyMarkdownCard(replyTo, chunk);
        } else {
          await this.messagePort.sendMarkdownCard(chatId, chunk);
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
          await this.messagePort.replyPost(replyTo, chunk);
        } else {
          await this.sendPost(chatId, chunk, 1);
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
  ): Promise<void> {
    const key = turnKey(event.threadId, event.turnId);
    const consumesReplyTarget = event.type === "turn.completed"
      || (
        event.type === "text.completed"
        && event.phase !== "commentary"
      );
    const replyTo = event.type === "turn.started" || consumesReplyTarget
      ? this.replyTargets.get(key)
      : undefined;
    if (
      event.type === "text.completed"
      && event.phase !== "commentary"
      && this.canSendCompletedAnswerFile(event.text)
    ) {
      try {
        await this.sendLongFinalAnswer(
          event.target.conversationId,
          event.text,
          replyTo,
        );
      } finally {
        if (consumesReplyTarget) {
          this.replyTargets.delete(key);
        }
      }
      return;
    }
    await this.sendMarkdown(
      event.target.conversationId,
      markdown,
      maximumFeishuMessageChunks,
      replyTo,
    );
    if (consumesReplyTarget) {
      this.replyTargets.delete(key);
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
      async () => {
        try {
          await this.messagePort.sendFile!(
            event.target.conversationId,
            feishuFinalAnswerFileName,
            file,
          );
        } catch (error) {
          await this.sendText(
            event.target.conversationId,
            "[完整文件发送失败，当前卡片仅包含有界预览]",
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
    );
    try {
      await this.messagePort.sendFile!(
        chatId,
        feishuFinalAnswerFileName,
        Buffer.from(text, "utf8"),
      );
    } catch (error) {
      await this.sendMarkdown(
        chatId,
        `${feishuFileFailureNotice}${tail}`,
        maximumFeishuMessageChunks - 1,
      );
      throw error;
    }
  }

  private async deliverThreadStatus(
    event: Extract<OutputEvent, { type: "thread.status" }>,
  ): Promise<void> {
    const card = renderFeishuThreadStatusCard(event.status);
    const current = this.threadStatusMessages.get(event.threadId);
    if (
      current
      && current.chatId === event.target.conversationId
    ) {
      if (current.status === event.status) {
        return;
      }
      try {
        await this.messagePort.updateCard(current.messageId, card);
      } catch (error) {
        if (this.threadStatusMessages.get(event.threadId) === current) {
          this.threadStatusMessages.delete(event.threadId);
        }
        throw error;
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
    const messageId = await this.messagePort.sendCard(
      event.target.conversationId,
      card,
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
          () => this.flushStream(key, false, false),
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
      () => this.flushStream(key, true, true),
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
        () => this.flushStream(key, false, false),
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
        () => this.flushStream(key, true, true),
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
      async () => {
        try {
          await this.messagePort.finishStreamingCard(
            completed.cardId,
            completed.sequence + 1,
            completed.summary,
            footer,
          );
        } catch (error) {
          await this.sendMarkdown(completed.chatId, footer);
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
  ): Promise<void> {
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    if (state.failed) {
      if (terminal) {
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
        const replyTo = state.phase === "commentary"
          ? undefined
          : this.replyTargets.get(replyKey);
        await this.sendMarkdown(
          state.chatId,
          markdown,
          remainingMessageBudget,
          replyTo,
        );
        if (replyTo !== undefined) {
          this.replyTargets.delete(replyKey);
        }
      }
      if (state.completionFooter !== undefined) {
        await this.sendMarkdown(state.chatId, state.completionFooter);
      }
      return;
    }
    try {
      const ready = await this.rollStreamingCards(state, terminal);
      if (!ready) {
        return;
      }
      if (state.lastSentText !== state.cardText) {
        state.sequence += 1;
        try {
          await this.messagePort.updateStreamingCard(
            state.cardId!,
            state.cardText,
            state.sequence,
          );
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
      if (terminal) {
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
          );
        }
      } catch (error) {
        this.streams.delete(key);
        if (state.completionFooter !== undefined) {
          await this.sendMarkdown(state.chatId, state.completionFooter);
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
      await this.ensureStreamingCard(state, head);
      if (state.lastSentText !== head) {
        state.sequence += 1;
        await this.messagePort.updateStreamingCard(
          state.cardId!,
          head,
          state.sequence,
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
    await this.ensureStreamingCard(state, state.cardText);
    return true;
  }

  private async ensureStreamingCard(
    state: FeishuStreamState,
    initialText: string,
  ): Promise<void> {
    if (state.cardId) {
      return;
    }
    if (state.cardCount >= maximumFeishuStreamingCards) {
      throw new Error("飞书流式卡片数量超过单个结果上限");
    }
    const replyKey = turnKey(state.threadId, state.turnId);
    const replyTo = state.phase === "commentary"
      ? undefined
      : this.replyTargets.get(replyKey);
    const created =
      replyTo !== undefined && this.messagePort.createStreamingReplyCard
        ? await this.messagePort.createStreamingReplyCard(replyTo, initialText)
        : await this.messagePort.createStreamingCard(
            state.chatId,
            initialText,
          );
    if (replyTo !== undefined) {
      this.replyTargets.delete(replyKey);
    }
    state.cardId = created.cardId;
    state.lastSentText = initialText;
    state.cardCount += 1;
  }

  private async recoverFailedStream(
    key: string,
    state: FeishuStreamState,
    fallbackPost: boolean,
  ): Promise<void> {
    this.streams.delete(key);
    let finishError: unknown;
    if (state.cardId) {
      state.sequence += 1;
      try {
        await this.messagePort.finishStreamingCard(
          state.cardId,
          state.sequence,
          state.lastSentText ?? state.cardText,
        );
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
      const replyTo = state.phase === "commentary"
        ? undefined
        : this.replyTargets.get(replyKey);
      if (replyTo !== undefined && this.messagePort.replyPost) {
        await this.messagePort.replyPost(replyTo, markdown);
      } else {
        await this.sendPost(
          state.chatId,
          markdown,
          remainingMessageBudget,
        );
      }
      if (replyTo !== undefined) {
        this.replyTargets.delete(replyKey);
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

interface BoundedStreamText {
  text: string;
  truncated: boolean;
}

function boundedStreamText(value: string): BoundedStreamText {
  return appendBoundedStreamText("", value);
}

function appendBoundedStreamText(
  current: string,
  addition: string,
): BoundedStreamText {
  let remaining =
    maximumFeishuBufferedStreamCharacters - [...current].length;
  if (remaining <= 0 || addition.length === 0) {
    return {
      text: current,
      truncated: addition.length > 0,
    };
  }
  let suffix = "";
  let truncated = false;
  for (const character of addition) {
    if (remaining === 0) {
      truncated = true;
      break;
    }
    suffix += character;
    remaining -= 1;
  }
  return {
    text: `${current}${suffix}`,
    truncated,
  };
}

function streamKey(threadId: string, turnId: string, itemId: string): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

function splitFeishuStreamingContent(
  text: string,
  maximumCharacters = maximumFeishuStreamingElementCharacters,
): [string, string] {
  const characters = [...text];
  const reservedEnd = maximumCharacters - 4;
  let end = reservedEnd;
  for (
    let index = reservedEnd;
    index >= Math.floor(reservedEnd * 0.75);
    index -= 1
  ) {
    if (characters[index - 1] === "\n") {
      end = index;
      break;
    }
  }
  const rawHead = characters.slice(0, end).join("");
  const rawTail = characters.slice(end).join("");
  const fenceLanguage = openFenceLanguage(rawHead);
  if (fenceLanguage === null) {
    return [rawHead, rawTail];
  }
  return [
    `${rawHead.endsWith("\n") ? rawHead : `${rawHead}\n`}\`\`\``,
    `\`\`\`${fenceLanguage}\n${rawTail}`,
  ];
}

function splitFeishuMarkdownCards(
  markdown: string,
  maximumChunks = maximumFeishuMessageChunks,
): string[] {
  const chunks: string[] = [];
  let remaining = markdown;
  while (
    [...remaining].length > maximumFeishuStreamingElementCharacters
    && chunks.length < maximumChunks - 1
  ) {
    const [head, tail] = splitFeishuStreamingContent(remaining);
    chunks.push(head);
    remaining = tail;
  }
  if ([...remaining].length > maximumFeishuStreamingElementCharacters) {
    const [head] = splitFeishuStreamingContent(remaining);
    chunks.push(appendFeishuStreamingTruncation(head));
  } else {
    chunks.push(remaining);
  }
  return chunks;
}

function openFenceLanguage(text: string): string | null {
  let language: string | null = null;
  for (const line of text.split("\n")) {
    const match = /^```([A-Za-z0-9_-]*)\s*$/u.exec(line);
    if (match) {
      language = language === null ? (match[1] ?? "") : null;
    }
  }
  return language;
}

function appendFeishuStreamingTruncation(
  text: string,
  maximumCharacters = maximumFeishuStreamingElementCharacters,
): string {
  const characters = [...text];
  const notice = [...feishuTruncationNotice];
  const closingFence = text.endsWith("\n```") ? [..."\n```"] : [];
  const contentLimit =
    maximumCharacters
    - notice.length
    - closingFence.length;
  const content = closingFence.length > 0
    ? characters.slice(0, Math.min(contentLimit, characters.length - 4))
    : characters.slice(0, contentLimit);
  return [
    ...content,
    ...closingFence,
    ...notice,
  ].join("");
}

function splitFeishuText(text: string): string[] {
  return splitFeishuContent(
    text,
    (value) => Buffer.byteLength(value, "utf8"),
  );
}

function splitFeishuPost(
  markdown: string,
  maximumChunks = maximumFeishuMessageChunks,
): string[] {
  return splitFeishuContent(
    markdown,
    (value) => Buffer.byteLength(encodeFeishuPostContent(value), "utf8"),
    maximumChunks,
  );
}

function splitFeishuContent(
  text: string,
  measureBytes: (value: string) => number,
  maximumChunks = maximumFeishuMessageChunks,
): string[] {
  if (measureBytes(text) <= maximumFeishuMessageContentBytes) {
    return [text];
  }
  const payloadLimit =
    maximumFeishuMessageContentBytes - feishuChunkHeaderReserveBytes;
  const payloads: string[] = [];
  const characters = [...text];
  let offset = 0;
  while (
    offset < characters.length
    && payloads.length < maximumChunks
  ) {
    const end = findLargestFittingEnd(
      characters,
      offset,
      payloadLimit,
      measureBytes,
    );
    if (end === offset) {
      throw new Error("飞书消息分片上限不足以容纳单个字符");
    }
    payloads.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  if (offset < characters.length) {
    const lastIndex = payloads.length - 1;
    payloads[lastIndex] = appendWithinByteLimit(
      payloads[lastIndex]!,
      feishuTruncationNotice,
      payloadLimit,
      measureBytes,
    );
  }
  return payloads.map(
    (payload, index) => `（${index + 1}/${payloads.length}）\n${payload}`,
  );
}

function findLargestFittingEnd(
  characters: readonly string[],
  offset: number,
  byteLimit: number,
  measureBytes: (value: string) => number,
): number {
  let low = offset + 1;
  let high = characters.length;
  let best = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(offset, middle).join("");
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function appendWithinByteLimit(
  text: string,
  suffix: string,
  byteLimit: number,
  measureBytes: (value: string) => number,
): string {
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${suffix}`;
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, best).join("")}${suffix}`;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}
