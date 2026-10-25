import { DeliveryReceipt } from "../delivery-receipt.js";
import type { Logger } from "pino";
import type { OutputEvent } from "../../conversation-core/index.js";
import type { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { surfaceDiagnosticContext } from "../diagnostics.js";
import type { TurnReplyTargets } from "../turn-reply-targets.js";
import { FeishuMessageError } from "./message-error.js";
import type { FeishuMessagePort } from "./outbox-message-port.js";
import {
  FeishuMarkdownSplitError,
  appendBoundedStreamText, appendFeishuStreamingTruncation, boundedStreamText,
  feishuPreviewNotice, feishuTruncationNotice, maximumFeishuMessageChunks, maximumFeishuStreamingCards,
  maximumFeishuStreamingElementCharacters, splitFeishuStreamingContent,
} from "./outbox-content.js";

const feishuStreamFlushDelayMs = 300;
const maximumFeishuActiveStreams = 100;

interface FeishuStreamState {
  previewAbort: AbortController;
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
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
  terminalOutcome?: "confirmed" | "failed";
  terminalSettled?: Promise<void>;
  truncationNotice?: string;
}

/** 正文流状态由此组件独占；共享 Outbox 的投递队列、关闭边界与降级发送。 */
export class FeishuTextStreams {
  private readonly streams = new Map<string, FeishuStreamState>();
  private streamCapacityWarningIssued = false;

  constructor(
    private readonly messagePort: FeishuMessagePort,
    private readonly delivery: Pick<ConversationDeliveryQueue, "enqueue">,
    private readonly replyTargets: Pick<TurnReplyTargets<string>, "get">,
    private readonly logger: Logger,
    private readonly isClosed: () => boolean,
    private readonly sendMarkdown: (
      chatId: string, markdown: string, maximumChunks: number, replyTo?: string,
      onFirstMessageId?: (messageId: string) => void, signal?: AbortSignal, truncationNotice?: string,
    ) => Promise<void>,
    private readonly sendPost: (
      chatId: string, markdown: string, maximumChunks: number, signal?: AbortSignal, replyTo?: string, truncationNotice?: string,
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
        { settled: () => { if (this.streams.get(key) === state) this.streams.delete(key); } },
      );
    }
  }

  clear(): void {
    this.streams.clear();
  }

  clearThread(threadId: string): void {
    for (const [key, state] of this.streams) {
      if (state.threadId !== threadId) continue;
      if (state.timer) clearTimeout(state.timer);
      if (state.terminalSettled === undefined) state.previewAbort.abort();
      if (this.streams.get(key) === state) this.streams.delete(key);
    }
  }

  /** Stop only this Turn locally; never finish a platform card during discard. */
  cancelTurn(chatId: string, threadId: string, turnId: string): void {
    for (const [key, state] of this.streams) {
      if (state.chatId !== chatId || state.threadId !== threadId || state.turnId !== turnId) continue;
      if (state.timer) clearTimeout(state.timer);
      if (state.terminalSettled === undefined) state.previewAbort.abort();
      state.flushGeneration += 1;
      this.streams.delete(key);
    }
  }

  acceptStreamDelta(
    event: Extract<OutputEvent, { type: "text.delta" }>,
  ): void {
    const key = streamKey(event.target.conversationId, event.threadId, event.turnId, event.itemId);
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
      previewAbort: new AbortController(),
      chatId: event.target.conversationId,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      text: "",
      cardText: "",
      flushGeneration: 0,
      truncated: false,
      sequence: 0,
      cardCount: 0,
      failed: false,
    };
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
        const generation = state.flushGeneration;
        this.delivery.enqueue(
          state.chatId,
          async (signal) => {
            if (this.streams.get(key) !== state || state.flushGeneration !== generation) return;
            await this.flushStream(key, false, false, signal, state);
          },
          false,
          { coalesceKey: `stream:${key}:${generation}` },
        );
      }, feishuStreamFlushDelayMs);
      state.timer.unref();
    }
  }

  completeStream(
    event: Extract<OutputEvent, { type: "text.completed" }>,
    completeFilePlanned = false,
  ): boolean {
    const key = streamKey(event.target.conversationId, event.threadId, event.turnId, event.itemId);
    const state = this.streams.get(key);
    if (!state) {
      return false;
    }
    state.truncationNotice = completeFilePlanned ? feishuPreviewNotice : feishuTruncationNotice;
    const bounded = boundedStreamText(event.text);
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
    let resolveTerminal!: () => void;
    state.terminalSettled = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    let released = false;
    const settled = (): void => {
      if (released) return;
      released = true;
      if (state.terminalOutcome === undefined) state.terminalOutcome = "failed";
      if (this.streams.get(key) === state) this.streams.delete(key);
      resolveTerminal();
    };
    const accepted = this.delivery.enqueue(
      state.chatId,
      (signal) => this.flushStream(key, true, true, signal, state),
      true,
      { settled },
    );
    if (!accepted) settled();
    return true;
  }

  flushStreamsBeforeVisibleOutput(
    chatId: string,
    threadId: string,
    turnId: string,
  ): void {
    for (const [key, state] of this.streams) {
      if (state.chatId !== chatId || state.threadId !== threadId || state.turnId !== turnId) {
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
    chatId: string,
    threadId: string,
    turnId: string,
    onSettled: (failed: boolean) => void,
  ): void {
    const matching = [...this.streams].filter(([, state]) =>
      state.chatId === chatId && state.threadId === threadId && state.turnId === turnId
    );
    let pending = matching.length;
    if (pending === 0) {
      onSettled(false);
      return;
    }
    let failed = false;
    const completionReceipt = DeliveryReceipt.current();
    const releaseCompletion = completionReceipt?.retain();
    // 正文平台失败只取消自身；授权、持久检查点和关闭仍沿完成事件的边界处理。
    DeliveryReceipt.without(() => {
      for (const [key, state] of matching) {
        let released = false;
        const settled = (): void => {
          if (released) return;
          released = true;
          if (state.terminalOutcome === undefined) state.terminalOutcome = "failed";
          failed ||= state.terminalOutcome === "failed";
          if (this.streams.get(key) === state) this.streams.delete(key);
          if (--pending === 0) {
            try { onSettled(failed); } finally { releaseCompletion?.(); }
          }
        };
        if (state.terminalSettled !== undefined) {
          // 已入队的完整正文由原回执拥有；等待其实际结束，不能因完成卡取消提前释放回复目标。
          void state.terminalSettled.then(settled);
          continue;
        }
        if (state.timer) {
          clearTimeout(state.timer);
          delete state.timer;
        }
        state.flushGeneration += 1;
        const receipt = completionReceipt === undefined ? undefined : new DeliveryReceipt(async (checkpoint) => {
          try { await completionReceipt.checkpoint(checkpoint); }
          catch (error) { completionReceipt.fail(error); throw error; }
        }, completionReceipt.controller.signal, true);
        const enqueue = (): boolean => this.delivery.enqueue(
          state.chatId,
          async (signal) => {
            if (state.terminalOutcome === undefined) await this.flushStream(key, true, true, signal, state);
          },
          true,
          { settled },
        );
        const accepted = receipt === undefined ? enqueue() : receipt.run(enqueue);
        receipt?.release();
        if (!accepted) settled();
      }
    });
  }

  private async flushStream(
    key: string,
    terminal: boolean,
    fallbackPost: boolean,
    signal?: AbortSignal,
    retainedState?: FeishuStreamState,
  ): Promise<void> {
    const state = retainedState ?? this.streams.get(key);
    if (!state) return;
    if (state.terminalSettled === undefined) {
      signal = signal ? AbortSignal.any([signal, state.previewAbort.signal]) : state.previewAbort.signal;
      signal.throwIfAborted();
    }
    if (terminal && state.terminalOutcome === "confirmed") return;
    if (terminal && state.terminalOutcome === "failed") throw new Error("飞书正文终态未确认，禁止自动重发");
    try {
      await this.flushStreamState(state, terminal, fallbackPost, signal);
      if (terminal) state.terminalOutcome = "confirmed";
    } catch (error) {
      if (terminal) {
        state.terminalOutcome = "failed";
      }
      throw error;
    }
  }

  private async flushStreamState(
    state: FeishuStreamState,
    terminal: boolean,
    fallbackPost: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (state.failed) {
      if (terminal && !signal?.aborted) {
        await this.recoverFailedStream(state, fallbackPost, signal);
      }
      return;
    }
    if (!state.cardId && terminal) {
      const remainingMessageBudget =
        maximumFeishuMessageChunks - state.cardCount;
      if (fallbackPost && remainingMessageBudget <= 0) DeliveryReceipt.current()?.markContentIncomplete();
      if (fallbackPost && remainingMessageBudget > 0) {
        const markdown = state.truncated
          ? `${state.cardText}${state.truncationNotice ?? feishuTruncationNotice}`
          : state.cardText;
        const replyKey = turnKey(state.threadId, state.turnId);
        const replyTo = this.replyTargets.get(state.chatId, replyKey);
        await this.sendMarkdown(
          state.chatId,
          markdown,
          remainingMessageBudget,
          replyTo,
          undefined,
          signal,
          state.truncationNotice,
        );
      }
      return;
    }
    try {
      const ready = await this.rollStreamingCards(state, terminal, signal);
      if (!ready || this.isClosed() || signal?.aborted) {
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
        await this.recoverFailedStream(state, fallbackPost, signal);
        if (error instanceof FeishuMarkdownSplitError && fallbackPost
          && state.cardCount < maximumFeishuMessageChunks && !this.isClosed() && !signal?.aborted) {
          this.logger.warn({
            ...surfaceDiagnosticContext(), component: "Feishu", fallback: "post", reason: "markdown-fence-budget",
          }, "飞书终态围栏超出卡片预算，Post 已确认恢复");
          return;
        }
      }
      throw error;
    }
    if (terminal) {
      try {
        await this.finishStreamCard(state, state.cardText, signal);
      } catch (error) {
        if (!this.isClosed() && !signal?.aborted && fallbackPost && !state.deliveryUncertain
          && state.lastSentText !== state.cardText) {
          const remaining = maximumFeishuMessageChunks - state.cardCount;
          if (remaining > 0) {
            const replyTo = this.replyTargets.get(state.chatId, turnKey(state.threadId, state.turnId));
            await this.sendPost(state.chatId, state.cardText, remaining, signal, replyTo, state.truncationNotice);
          }
        }
        throw error;
      }
    }
  }

  /** 已知卡片的覆盖更新可安全重试；不确定结果不切换为新消息重播。 */
  private async finishStreamCard(
    state: FeishuStreamState,
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.isClosed()) throw new Error("飞书输出已关闭");
      signal?.throwIfAborted();
      state.sequence += 1;
      try {
        if (signal !== undefined) {
          await this.messagePort.finishStreamingCard(state.cardId!, state.sequence, body, signal);
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
        ? appendFeishuStreamingTruncation(rawHead, maximumCharacters, state.truncationNotice)
        : rawHead;
      await this.ensureStreamingCard(state, head, signal);
      await this.finishStreamCard(state, head, signal);
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
    const replyTo = this.replyTargets.get(state.chatId, replyKey);
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
    state: FeishuStreamState,
    fallbackPost: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    let finishError: unknown;
    if (state.cardId && !state.deliveryUncertain && !this.isClosed()) {
      state.sequence += 1;
      try {
        if (signal) {
          await this.messagePort.finishStreamingCard(state.cardId, state.sequence, state.lastSentText ?? state.cardText, signal);
        } else {
          await this.messagePort.finishStreamingCard(state.cardId, state.sequence, state.lastSentText ?? state.cardText);
        }
      } catch (error) {
        finishError = error;
      }
    }
    const remainingMessageBudget =
      maximumFeishuMessageChunks - state.cardCount;
    if (fallbackPost && remainingMessageBudget <= 0) DeliveryReceipt.current()?.markContentIncomplete();
    if (!this.isClosed() && !signal?.aborted && fallbackPost && !state.deliveryUncertain && remainingMessageBudget > 0) {
      const markdown = state.truncated
        ? `${state.text}${state.truncationNotice ?? feishuTruncationNotice}`
        : state.text;
      const replyKey = turnKey(state.threadId, state.turnId);
      const replyTo = this.replyTargets.get(state.chatId, replyKey);
      await this.sendPost(
        state.chatId,
        markdown,
        remainingMessageBudget,
        signal,
        replyTo,
        state.truncationNotice,
      );
    }
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

function streamKey(chatId: string, threadId: string, turnId: string, itemId: string): string {
  return JSON.stringify([chatId, threadId, turnId, itemId]);
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}
