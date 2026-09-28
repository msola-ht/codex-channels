import { DeliveryReceipt } from "../delivery-receipt.js";
import { InputFile, type Api } from "grammy";
import type { InputRichMessage } from "grammy/types";
import type { Logger } from "pino";
import type { MessagePhase, OutputEvent } from "../../conversation-core/index.js";
import type { ConversationDeliveryQueue, ConversationDeliveryOptions } from "../conversation-delivery-queue.js";
import type { TurnReplyTargets } from "../turn-reply-targets.js";
import { surfaceDiagnosticContext } from "../diagnostics.js";
import { contentTruncatedText, emptyCodexResponseText } from "../output-copy.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { telegramAbortSignal } from "./sdk-signal.js";
import { isTelegramBadRequest, isTelegramDeliveryUncertain, isTelegramFormatRejection, isTelegramMissingMessage, telegramErrorMetadata } from "./error-metadata.js";
import { splitTelegramText } from "./format.js";
import { formatMarkdownAsTelegramHtml, formatMarkdownAsTelegramHtmlChunks, telegramHtmlToPlainText } from "./markdown-format.js";
import { hasTelegramReplyHeading } from "./html-format.js";
import { planLongFinalMessage, type LongFinalMessagePlan } from "./long-message-format.js";
import { replyOptions, htmlSendOptions, operationEditOptions } from "./message-options.js";

interface StreamState {
  chatId: string;
  turnKey: string;
  text: string;
  messageId: number | undefined;
  creationUncertain: boolean;
  phase: MessagePhase | null | undefined;
  completed: boolean;
  truncated: boolean;
  timer: NodeJS.Timeout | undefined;
}

const maximumRichMarkdownCharacters = 32_000;
const maximumTelegramActiveStreams = 100;
const maximumTelegramBufferedStreamCharacters = 1_000_000;
const telegramStreamTruncationMarker = `\n\n（${contentTruncatedText}）`;

export type TelegramFinalMessageFormat = "html" | "rich";

/** Owns text delivery state; all sends use the Outbox's existing Conversation queue. */
export class TelegramTextStreams {
  private readonly streams = new Map<string, StreamState>();
  private readonly notifiedTurns = new Set<string>();
  private streamCapacityWarningIssued = false;

  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
    private readonly executor: TelegramApiExecutor,
    private readonly delivery: Pick<ConversationDeliveryQueue, "enqueue">,
    private readonly replyTargets: Pick<TurnReplyTargets<number>, "get">,
    private readonly beforeNewStream: (chatId: string, turnKey: string) => void,
    private readonly options: { finalMessageFormat?: TelegramFinalMessageFormat },
    private readonly sendPlain: (chatId: string, text: string, replyTo?: number, silent?: boolean, signal?: AbortSignal) => Promise<number>,
  ) {}

  delta(event: Extract<OutputEvent, { type: "text.delta" }>): void {
    const chatId = event.target.conversationId;
    const turnKey = this.turnKey(event.threadId, event.turnId);
    const key = this.streamKey(chatId, turnKey, event.itemId);
    const existing = this.streams.get(key);
    if (!existing && this.streams.size >= maximumTelegramActiveStreams) {
      if (!this.streamCapacityWarningIssued) {
        this.streamCapacityWarningIssued = true;
        this.logger.warn(
          {
            ...surfaceDiagnosticContext(),
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
      this.beforeNewStream(chatId, turnKey);
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
        this.enqueue(chatId, (signal) => this.flush(chatId, key, false, undefined, signal), false);
      }, 1_000);
      state.timer.unref();
    }
    return;
  }

  discard(event: Extract<OutputEvent, { type: "text.completed" }>): void {
    const key = this.streamKey(event.target.conversationId, this.turnKey(event.threadId, event.turnId), event.itemId);
    const state = this.streams.get(key);
    if (state?.timer) clearTimeout(state.timer);
    this.streams.delete(key);
  }

  complete(event: Extract<OutputEvent, { type: "text.completed" }>): void {
    const chatId = event.target.conversationId;
    const turnKey = this.turnKey(event.threadId, event.turnId);
    const key = this.streamKey(chatId, turnKey, event.itemId);
    const existing = this.streams.get(key);
    const state = existing ?? this.createStream(chatId, turnKey);
    const completedText = `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`;
    // Durable admission already bounds the full payload. A truncated preview
    // must never become the source of the acknowledged final document.
    const bounded = DeliveryReceipt.current()
      ? { text: completedText, truncated: false }
      : boundedTelegramStreamText(completedText);
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
      // Reliable output owns this state even if lifecycle observation clears the live Map.
      (signal) => this.flush(chatId, key, true, state, signal),
      true,
      { purpose: "answer" },
    );
    return;
  }

  prepareTurnCompletion(chatId: string, threadId: string, turnId: string): (chatId: string, signal?: AbortSignal) => Promise<void> {
    const keys = this.streamKeysForTurn(chatId, threadId, turnId);
    for (const key of keys) {
      const stream = this.streams.get(key);
      if (stream?.timer) {
        clearTimeout(stream.timer);
        stream.timer = undefined;
      }
    }
    return async (chatId, signal) => {
      for (const key of keys) await this.flush(chatId, key, true, undefined, signal);
    };
  }

  clearTurnNotification(turnKey: string): void {
    this.notifiedTurns.delete(turnKey);
  }

  prepareClose(): void {
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.completed) {
        this.enqueue(state.chatId, (signal) => this.flush(state.chatId, key, true, undefined, signal), true);
      }
    }
  }

  clear(): void {
    this.streams.clear();
    this.notifiedTurns.clear();
  }

  prepareInteraction(chatId: string): void {
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

  clearThread(threadId: string): void {
    for (const [key, stream] of this.streams) {
      if (stream.turnKey.startsWith(`${threadId}:`)) {
        if (stream.timer) {
          clearTimeout(stream.timer);
        }
        this.streams.delete(key);
      }
    }
    const prefix = `${threadId}:`;
    for (const turnKey of this.notifiedTurns) {
      if (turnKey.startsWith(prefix)) {
        this.notifiedTurns.delete(turnKey);
      }
    }
  }

  flushBeforeVisibleOutput(chatId: string, turnKey: string): void {
    for (const [key, state] of this.streams) {
      if (state.chatId !== chatId || state.turnKey !== turnKey || !state.timer) {
        continue;
      }
      clearTimeout(state.timer);
      state.timer = undefined;
      this.enqueue(chatId, (signal) => this.flush(chatId, key, false, undefined, signal), true);
    }
  }

  private async flush(
    chatId: string,
    key: string,
    final: boolean,
    standaloneState?: StreamState,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = standaloneState ?? this.streams.get(key);
    if (!state) {
      return;
    }
    // 终态尝试从活动流脱离，Turn 完成不能从头重播一次已部分发送或结果不确定的回复。
    if (final && this.streams.get(key) === state) this.streams.delete(key);
    await this.flushState(chatId, state, final, signal);
    if (final && state.phase !== "commentary") {
      this.logger.info({ ...surfaceDiagnosticContext(), chatId, messageId: state.messageId },
        "Telegram 完成正文投递完成");
    }
  }

  private async flushState(chatId: string, state: StreamState, final: boolean, signal?: AbortSignal): Promise<void> {
    if (state.creationUncertain) {
      throw new Error("Telegram 流式正文首次发送结果不确定，停止自动重发");
    }
    if (!state.text.trim()) {
      if (!final || state.phase === "commentary") {
        return;
      }
      state.text = emptyCodexResponseText;
    }
    const text = state.text.trimEnd();
    if (final && state.phase !== "commentary") {
      const longMessage = planLongFinalMessage(text);
      if (longMessage) {
        state.messageId = await this.sendLongFinal(chatId, state, text, longMessage, signal);
        return;
      }
      {
        // Native Rich Markdown must not recreate the reserved interaction heading.
        const reservedHeading = hasTelegramReplyHeading(formatMarkdownAsTelegramHtml(text.split("\n", 1)[0]!) ?? "");
        const format = reservedHeading ? "html" : this.options.finalMessageFormat ?? "html";
        const formatted = format === "rich"
          ? canSendRichMarkdown(text) ? text : undefined
          : formatMarkdownAsTelegramHtml(text);
        if (formatted !== undefined && (format === "rich" || state.phase === "final_answer" || formatted !== text)) {
          try {
            state.messageId = format === "rich"
              ? await this.sendRichFinal(chatId, state, formatted, signal)
              : await this.sendHtmlFinal(chatId, state, formatted, signal);
            this.logger.info({ ...surfaceDiagnosticContext(), chatId, format, messageId: state.messageId },
              "Telegram 完成正文已格式化");
            return;
          } catch (error) {
            if (signal?.aborted || !isTelegramFormatRejection(error)) throw error;
            this.logger.warn(
              {
                ...surfaceDiagnosticContext(),
                chatId,
                format,
                ...telegramErrorMetadata(error),
              },
              "Telegram 格式化消息发送或编辑失败，回退纯文本",
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
        await this.executor.editMessageText(
          { chatId, critical: final },
          (requestSignal) => this.api.editMessageText(chatId, state.messageId!, first, {}, telegramAbortSignal(requestSignal)),
          signal,
        );
      } catch (error) {
        if (final && !signal?.aborted && isTelegramBadRequest(error)) {
          state.messageId = await this.sendFirstChunk(chatId, state, first, signal);
        } else {
          throw error;
        }
      }
    } else {
      state.messageId = await this.sendFirstChunk(chatId, state, first, signal);
    }
    if (final) {
      for (const chunk of rest) {
        await this.sendPlain(chatId, chunk, undefined, true, signal);
      }
    }
  }

  private createStream(chatId: string, turnKey: string): StreamState {
    return {
      chatId,
      turnKey,
      text: "",
      messageId: undefined,
      creationUncertain: false,
      phase: undefined,
      completed: false,
      truncated: false,
      timer: undefined,
    };
  }

  private streamKey(chatId: string, turnKey: string, itemId: string): string {
    return JSON.stringify([chatId, turnKey, itemId]);
  }

  private streamKeysForTurn(chatId: string, threadId: string, turnId: string): string[] {
    const turnKey = this.turnKey(threadId, turnId);
    return [...this.streams].filter(([, state]) => state.chatId === chatId && state.turnKey === turnKey).map(([key]) => key);
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private enqueue(chatId: string, run: (signal: AbortSignal) => Promise<void>, critical: boolean, options?: ConversationDeliveryOptions): boolean {
    return this.delivery.enqueue(chatId, run, critical, options);
  }

  private async sendFirstChunk(chatId: string, state: StreamState, text: string, signal?: AbortSignal): Promise<number> {
    const replyTo = this.replyTargets.get(chatId, state.turnKey);
    const silent = state.phase === "commentary" || this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      (requestSignal) => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent), telegramAbortSignal(requestSignal)),
      signal,
    ).catch((error: unknown) => {
      // 没拿到消息 ID 时，后续定时刷新同样不能把未知结果当作“未发送”。
      if (isTelegramDeliveryUncertain(error)) state.creationUncertain = true;
      throw error;
    });
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
      try {
        await this.executor.editMessageText(
          { chatId, critical: true },
          (requestSignal) => this.api.editMessageText(chatId, state.messageId!, richMessage, {}, telegramAbortSignal(requestSignal)),
          signal,
        );
        return state.messageId;
      } catch (error) {
        if (signal?.aborted || !isTelegramMissingMessage(error)) throw error;
        state.messageId = undefined;
      }
    }

    const replyTo = this.replyTargets.get(chatId, state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendRichMessage", critical: true },
      (requestSignal) => this.api.sendRichMessage(
        chatId,
        richMessage,
        replyOptions(replyTo, silent),
        telegramAbortSignal(requestSignal),
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
      try {
        await this.executor.editMessageText(
          { chatId, critical: true },
          (requestSignal) => this.api.editMessageText(chatId, state.messageId!, html, operationEditOptions(), telegramAbortSignal(requestSignal)),
          signal,
        );
        return state.messageId;
      } catch (error) {
        if (signal?.aborted || !isTelegramMissingMessage(error)) throw error;
        state.messageId = undefined;
      }
    }

    const replyTo = this.replyTargets.get(chatId, state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      (requestSignal) => this.api.sendMessage(chatId, html, htmlSendOptions(replyTo, silent), telegramAbortSignal(requestSignal)),
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
      return this.sendHtmlChunksFinal(chatId, state, plan.chunks, signal);
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
          telegramAbortSignal(requestSignal),
        ),
        signal,
      );
      return state.messageId;
    } catch (error) {
      if (signal?.aborted || !isTelegramBadRequest(error)) throw error;
      this.logger.warn(
        { ...surfaceDiagnosticContext(), chatId, ...telegramErrorMetadata(error) },
        "Telegram 完整回复文件发送失败，回退分段 HTML",
      );
      return this.sendHtmlChunksFinal(chatId, state, formatMarkdownAsTelegramHtmlChunks(text), signal);
    }
  }

  private async sendHtmlChunksFinal(
    chatId: string,
    state: StreamState,
    chunks: readonly string[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (chunks.length === 0) throw new Error("Telegram 分段回复没有可发送内容");
    let deliveredChunk = false;
    for (const [index, html] of chunks.entries()) {
      const plain = telegramHtmlToPlainText(html);
      if (!plain.trim()) continue;
      const first = !deliveredChunk;
      const deliver = async (text: string, formatted: boolean): Promise<void> => {
        if (first && state.messageId !== undefined) {
          await this.executor.editMessageText(
            { chatId, critical: true },
            (requestSignal) => this.api.editMessageText(chatId, state.messageId!, text,
              formatted ? operationEditOptions() : {}, telegramAbortSignal(requestSignal)), signal,
          ).catch(async (error: unknown) => {
            if (signal?.aborted || !isTelegramMissingMessage(error)) throw error;
            state.messageId = undefined;
            await deliver(text, formatted);
          });
        } else {
          const replyTo = first ? this.replyTargets.get(chatId, state.turnKey) : undefined;
          const silent = !first || this.notifiedTurns.has(state.turnKey);
          const message = await this.executor.call(
            { chatId, operation: "sendMessage", critical: true },
            (requestSignal) => this.api.sendMessage(chatId, text,
              formatted ? htmlSendOptions(replyTo, silent) : replyOptions(replyTo, silent),
              telegramAbortSignal(requestSignal)), signal,
          );
          if (first) state.messageId = message.message_id;
          if (!silent) this.notifiedTurns.add(state.turnKey);
        }
      };
      try {
        await deliver(html, true);
      } catch (error) {
        if (signal?.aborted || !isTelegramFormatRejection(error)) throw error;
        this.logger.warn({ ...surfaceDiagnosticContext(), chatId, chunkIndex: index,
          ...telegramErrorMetadata(error) }, "Telegram 当前分段格式被拒绝，回退该段纯文本");
        await deliver(plain, false);
      }
      deliveredChunk = true;
    }
    if (state.messageId === undefined) throw new Error("Telegram 分段回复没有可发送内容");
    return state.messageId;
  }


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
