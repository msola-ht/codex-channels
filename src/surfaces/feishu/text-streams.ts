import { DeliveryReceipt } from "../delivery-receipt.js";
import type { Logger } from "pino";
import type { OutputEvent } from "../../conversation-core/index.js";
import type { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { surfaceDiagnosticContext } from "../diagnostics.js";
import type { TurnReplyTargets } from "../turn-reply-targets.js";
import { FeishuMessageError } from "./message-error.js";
import type { FeishuMessagePort } from "./outbox-message-port.js";
import {
  appendBoundedStreamText, appendFeishuStreamingTruncation, boundedStreamText,
  feishuTruncationNotice, maximumFeishuMessageChunks, maximumFeishuStreamingCards,
  maximumFeishuStreamingElementCharacters, splitFeishuStreamingContent,
} from "./outbox-content.js";

const feishuStreamFlushDelayMs = 300;
const maximumFeishuActiveStreams = 100;
const maximumFeishuFinishedStreams = 100;

interface FeishuStreamState {
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  phase?: "commentary" | "final_answer" | null;
  text: string;
  cardText: string;
  flushGeneration: number;
  truncated: boolean;
  sequence: number;
  cardCount: number;
  cardId?: string;
  lastSentText?: string;
  timer?: NodeJS.Timeout;
  failed: boolean;
  deliveryUncertain?: boolean;
  completionFooter?: string;
}

interface FinishedFeishuStream {
  chatId: string;
  cardId: string;
  sequence: number;
  summary: string;
}

/** 正文流状态由此组件独占；共享 Outbox 的投递队列、关闭边界与降级发送。 */
export class FeishuTextStreams {
  private readonly streams = new Map<string, FeishuStreamState>();
  private readonly finishedStreams = new Map<string, FinishedFeishuStream>();
  private streamCapacityWarningIssued = false;

  constructor(
    private readonly messagePort: FeishuMessagePort,
    private readonly delivery: Pick<ConversationDeliveryQueue, "enqueue">,
    private readonly replyTargets: Pick<TurnReplyTargets<string>, "get">,
    private readonly logger: Logger,
    private readonly isClosed: () => boolean,
    private readonly sendMarkdown: (
      chatId: string, markdown: string, maximumChunks: number, replyTo?: string,
      onFirstMessageId?: (messageId: string) => void, signal?: AbortSignal,
    ) => Promise<void>,
    private readonly sendPost: (
      chatId: string, markdown: string, maximumChunks: number, signal?: AbortSignal, replyTo?: string,
    ) => Promise<number>,
  ) {}

  prepareClose(): void {
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        (signal) => this.flushStream(key, true, false, signal),
        true,
      );
    }
  }

  clear(): void {
    this.streams.clear();
    this.finishedStreams.clear();
  }

  acceptStreamDelta(
    event: Extract<OutputEvent, { type: "text.delta" }>,
  ): void {
    const key = streamKey(event.threadId, event.turnId, event.itemId);
    const existing = this.streams.get(key);
    if (!existing && this.streams.size >= maximumFeishuActiveStreams) {
      if (!this.streamCapacityWarningIssued) {
        this.streamCapacityWarningIssued = true;
        this.logger.warn(
          {
            ...surfaceDiagnosticContext(),
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
      flushGeneration: 0,
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
          { coalesceKey: `stream:${key}:${state.flushGeneration}` },
        );
      }, feishuStreamFlushDelayMs);
      state.timer.unref();
    }
  }

  completeStream(
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
    state.flushGeneration += 1;
    this.delivery.enqueue(
      state.chatId,
      (signal) => this.flushStream(key, true, true, signal),
      true,
    );
    return true;
  }

  flushStreamsBeforeVisibleOutput(
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
      state.flushGeneration += 1;
      this.delivery.enqueue(
        state.chatId,
        (signal) => this.flushStream(key, false, false, signal),
        true,
      );
    }
  }

  finishStreamsForTurn(
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
      state.flushGeneration += 1;
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

  private async withStreamFooter(
    state: FeishuStreamState,
    signal: AbortSignal | undefined,
    sendBody: () => Promise<void>,
  ): Promise<void> {
    try {
      await sendBody();
    } finally {
      if (!this.isClosed() && !signal?.aborted && state.completionFooter !== undefined) {
        await this.sendMarkdown(state.chatId, state.completionFooter, maximumFeishuMessageChunks, undefined, undefined, signal);
      }
    }
  }

  private async flushStream(
    key: string,
    terminal: boolean,
    fallbackPost: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    if (state.failed) {
      if (terminal && !signal?.aborted) {
        await this.recoverFailedStream(key, state, fallbackPost, signal);
      }
      return;
    }
    if (!state.cardId && terminal) {
      this.streams.delete(key);
      await this.withStreamFooter(state, signal, async () => {
        const remainingMessageBudget =
          maximumFeishuMessageChunks - state.cardCount;
        if (fallbackPost && remainingMessageBudget <= 0) DeliveryReceipt.current()?.markContentIncomplete();
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
            signal,
          );
        }
      });
      return;
    }
    try {
      const ready = await this.rollStreamingCards(state, terminal, signal);
      if (!ready || this.isClosed() || signal?.aborted) {
        if (terminal && !ready && DeliveryReceipt.current()) this.streams.delete(key);
        return;
      }
      if (!terminal && state.lastSentText !== state.cardText) {
        const sentText = state.cardText;
        state.sequence += 1;
        try {
          if (signal) {
            await this.messagePort.updateStreamingCard(state.cardId!, sentText, state.sequence, signal);
          } else {
            await this.messagePort.updateStreamingCard(state.cardId!, sentText, state.sequence);
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
        state.lastSentText = sentText;
      }
    } catch (error) {
      state.failed = true;
      if (terminal && !signal?.aborted) {
        await this.recoverFailedStream(key, state, fallbackPost, signal);
      }
      throw error;
    }
    if (terminal) {
      try {
        const footerAtStart = state.completionFooter;
        await this.finishStreamCard(state, state.cardText, footerAtStart, signal);
        if (footerAtStart === undefined && state.completionFooter !== undefined) {
          await this.finishStreamCard(state, state.cardText, state.completionFooter, signal);
        }
      } catch (error) {
        this.streams.delete(key);
        await this.withStreamFooter(state, signal, async () => {
          if (!this.isClosed() && !signal?.aborted && fallbackPost && !state.deliveryUncertain
            && state.lastSentText !== state.cardText) {
            const remaining = maximumFeishuMessageChunks - state.cardCount;
            if (remaining > 0) {
              const replyTo = this.replyTargets.get(turnKey(state.threadId, state.turnId));
              await this.sendPost(state.chatId, state.cardText, remaining, signal, replyTo);
            }
          }
        });
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

  /** 已知卡片的覆盖更新可安全重试；不确定结果不切换为新消息重播。 */
  private async finishStreamCard(
    state: FeishuStreamState,
    body: string,
    footer: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.isClosed()) throw new Error("飞书输出已关闭");
      signal?.throwIfAborted();
      state.sequence += 1;
      try {
        if (signal !== undefined) {
          await this.messagePort.finishStreamingCard(state.cardId!, state.sequence, body, footer, signal);
        } else if (footer !== undefined) {
          await this.messagePort.finishStreamingCard(state.cardId!, state.sequence, body, footer);
        } else {
          await this.messagePort.finishStreamingCard(state.cardId!, state.sequence, body);
        }
        state.lastSentText = body;
        state.deliveryUncertain = false;
        return;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        const rejected = error instanceof FeishuMessageError
          && (error.code === "rate-limited" || error.code === "invalid-response");
        if (!rejected) state.deliveryUncertain = true;
        if (rejected || attempt === 1) throw error;
      }
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
      const snapshot = state.cardText;
      const [rawHead, tail] = splitFeishuStreamingContent(
        snapshot,
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
      await this.finishStreamCard(state, head, undefined, signal);
      delete state.cardId;
      delete state.lastSentText;
      state.sequence = 0;
      // New deltas may arrive while the platform request is in flight.
      if (!state.cardText.startsWith(snapshot)) {
        throw new Error("飞书流式正文在分卡期间已被修正");
      }
      state.cardText = tail + state.cardText.slice(snapshot.length);
      if (reachesCardLimit) {
        const receipt = DeliveryReceipt.current();
        if (terminal && receipt) {
          receipt.markContentIncomplete();
          return false;
        }
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
    // Card creation can span enough deltas to require another split.
    if ([...state.cardText].length > maximumFeishuStreamingElementCharacters) {
      return this.rollStreamingCards(state, terminal, signal);
    }
    return true;
  }

  private async ensureStreamingCard(
    state: FeishuStreamState,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.isClosed()) throw new Error("飞书输出已关闭");
    if (state.cardId) {
      return;
    }
    if (state.cardCount >= maximumFeishuStreamingCards) {
      throw new Error("飞书流式卡片数量超过单个结果上限");
    }
    const replyKey = turnKey(state.threadId, state.turnId);
    const replyTo = this.replyTargets.get(replyKey);
    try {
      const created =
        replyTo !== undefined && this.messagePort.createStreamingReplyCard
          ? await this.messagePort.createStreamingReplyCard(replyTo, initialText, signal)
          : await this.messagePort.createStreamingCard(
              state.chatId,
              initialText,
              signal,
            );
      state.cardId = created.cardId;
      state.lastSentText = initialText;
      state.cardCount += 1;
    } catch (error) {
      // 没有拿到消息 ID 的发送可能已经成功；只对确定未发送的错误允许新消息降级。
      const rejected = error instanceof FeishuMessageError
        && (error.code === "rate-limited" || error.code === "card-create-failed"
          || error.code === "client-create-failed" || error.code === "invalid-credentials");
      if (!rejected) state.deliveryUncertain = true;
      throw error;
    }
  }

  private async recoverFailedStream(
    key: string,
    state: FeishuStreamState,
    fallbackPost: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.streams.delete(key);
    let finishError: unknown;
    if (state.cardId && !state.deliveryUncertain && !this.isClosed()) {
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
    await this.withStreamFooter(state, signal, async () => {
      const remainingMessageBudget =
        maximumFeishuMessageChunks - state.cardCount;
      if (fallbackPost && remainingMessageBudget <= 0) DeliveryReceipt.current()?.markContentIncomplete();
      if (!this.isClosed() && !signal?.aborted && fallbackPost && !state.deliveryUncertain && remainingMessageBudget > 0) {
        const markdown = state.truncated
          ? `${state.text}${feishuTruncationNotice}`
          : state.text;
        const replyKey = turnKey(state.threadId, state.turnId);
        const replyTo = this.replyTargets.get(replyKey);
        await this.sendPost(
          state.chatId,
          markdown,
          remainingMessageBudget,
          signal,
          replyTo,
        );
      }
    });
    if (state.deliveryUncertain) {
      throw new FeishuMessageError("send-failed", "飞书正文投递结果未确认，未重播正文");
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
