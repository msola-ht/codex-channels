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
import { planLongFinalMessage, type LongFinalMessagePlan } from "./long-message-format.js";
import { replyOptions, htmlSendOptions, operationEditOptions } from "./message-options.js";

interface StreamState {
  chatId: string;
  turnKey: string;
  authorization: AbortSignal;
  activity: StreamActivity | undefined;
  text: string;
  messageId: number | undefined;
  creationUncertain: boolean;
  phase: MessagePhase | null | undefined;
  previewAdmitted: boolean;
  previewStarted: boolean;
  previewClosed: boolean;
  completed: boolean;
  truncated: boolean;
  timer: NodeJS.Timeout | undefined;
}

interface StreamActivity {
  chatId: string;
  turnKey: string;
  authorization: AbortSignal;
  controller: AbortController;
}

const maximumTelegramActiveStreams = 100;
const maximumTelegramBufferedStreamCharacters = 1_000_000;
const telegramStreamTruncationMarker = `\n\n（${contentTruncatedText}）`;

export type TelegramFinalMessageFormat = "html" | "rich";

/** Owns text delivery state; all sends use the Outbox's existing Conversation queue. */
export class TelegramTextStreams {
  private readonly streams = new Map<string, StreamState>();
  private readonly activities = new Map<string, StreamActivity>();
  private readonly observedDeltas = new WeakMap<Extract<OutputEvent, { type: "text.delta" }>, StreamActivity | undefined>();
  private readonly observedDeltaStates = new WeakMap<Extract<OutputEvent, { type: "text.delta" }>, StreamState | undefined>();
  private readonly notifiedTurns = new Set<string>();
  private streamCapacityWarningIssued = false;
  private activityCapacityWarningIssued = false;

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

  startTurn(chatId: string, threadId: string, turnId: string): void {
    const turnKey = this.turnKey(threadId, turnId);
    const key = this.activityKey(chatId, turnKey);
    const authorization = this.executor.authorizationSignal(chatId);
    if (authorization.aborted || this.activities.get(key)?.authorization === authorization) return;
    for (const [activityKey, activity] of this.activities) {
      if (activity.chatId === chatId && activity.turnKey.startsWith(`${threadId}:`)) {
        this.removeActivity(activityKey, activity);
      }
    }
    // These are disposable live admission identities, never a history of revoked Items.
    // Eviction only loses an intermediate preview; complete Items have their own delivery.
    if (this.activities.size >= maximumTelegramActiveStreams) {
      const oldest = this.activities.entries().next().value!;
      this.removeActivity(...oldest);
      if (!this.activityCapacityWarningIssued) {
        this.activityCapacityWarningIssued = true;
        this.logger.warn({ ...surfaceDiagnosticContext(), component: "Telegram",
          maximumActiveTurns: maximumTelegramActiveStreams }, "Telegram 活动轮次预览已满，已取消最旧的非关键预览");
      }
    } else {
      this.activityCapacityWarningIssued = false;
    }
    this.activities.set(key, { chatId, turnKey, authorization, controller: new AbortController() });
  }

  observeDelta(event: Extract<OutputEvent, { type: "text.delta" }>, previewAllowed = true): void {
    // Reader observation precedes routing waits. Re-observing the same live event
    // must not attach it to a later authorization or restored Turn identity.
    if (this.observedDeltas.has(event)) return;
    this.observedDeltas.set(event, this.activities.get(this.activityKey(
      event.target.conversationId, this.turnKey(event.threadId, event.turnId),
    )));
    const chatId = event.target.conversationId;
    const turnKey = this.turnKey(event.threadId, event.turnId);
    const key = this.streamKey(chatId, turnKey, event.itemId);
    const activity = this.activities.get(this.activityKey(chatId, turnKey));
    if (!this.executor.isAuthorized(chatId) || !activity || this.observedDeltas.get(event) !== activity
      || activity.authorization.aborted || activity.controller.signal.aborted) return;
    const existing = this.streams.get(key);
    if (existing?.authorization.aborted) return;
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
    const state = existing ?? this.createStream(chatId, turnKey, activity);
    if (state.previewClosed) return;
    state.previewAdmitted ||= previewAllowed;
    const bounded = boundedTelegramStreamText(`${state.text}${event.text}`);
    state.text = bounded.text;
    state.truncated ||= bounded.truncated;
    if (event.phase !== undefined) {
      state.phase = event.phase;
    }
    this.streams.set(key, state);
    this.observedDeltaStates.set(event, state);
  }

  delta(event: Extract<OutputEvent, { type: "text.delta" }>): void {
    const chatId = event.target.conversationId;
    const turnKey = this.turnKey(event.threadId, event.turnId);
    const key = this.streamKey(chatId, turnKey, event.itemId);
    const state = this.observedDeltaStates.get(event);
    if (!state || this.streams.get(key) !== state || state.previewClosed || state.authorization.aborted) return;
    if (!state.previewAdmitted) return;
    if (!state.previewStarted) {
      state.previewStarted = true;
      this.beforeNewStream(chatId, turnKey);
    }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        this.enqueue(chatId, (signal) => this.flush(chatId, key, false, state, signal), false, { signal: state.authorization });
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

  hasAdmittedPreview(event: Extract<OutputEvent, { type: "text.completed" }>): boolean {
    return this.streams.get(this.streamKey(event.target.conversationId,
      this.turnKey(event.threadId, event.turnId), event.itemId))?.previewAdmitted === true;
  }

  observeComplete(event: Extract<OutputEvent, { type: "text.completed" }>): void {
    const state = this.streams.get(this.streamKey(event.target.conversationId,
      this.turnKey(event.threadId, event.turnId), event.itemId));
    if (state) state.previewClosed = true;
  }

  discardUnadmittedPreviewsForTurn(chatId: string, threadId: string, turnId: string): void {
    for (const key of this.streamKeysForTurn(chatId, threadId, turnId)) {
      const state = this.streams.get(key)!;
      state.previewClosed = true;
      // An unknown phase is still withheld until an authoritative complete Item
      // or final_answer delta arrives. Turn completion cannot grant admission.
      if (state.previewAdmitted) continue;
      if (state.timer) clearTimeout(state.timer);
      this.streams.delete(key);
    }
  }

  complete(event: Extract<OutputEvent, { type: "text.completed" }>): void {
    const chatId = event.target.conversationId;
    const turnKey = this.turnKey(event.threadId, event.turnId);
    const key = this.streamKey(chatId, turnKey, event.itemId);
    const existing = this.streams.get(key);
    // A reliable complete Item owns the full content and the current authorization.
    // Never reuse a revoked preview's cache, message handle or cancellation scope.
    const state = existing && !existing.authorization.aborted ? existing : this.createStream(chatId, turnKey);
    state.authorization = this.executor.authorizationSignal(chatId);
    state.activity = undefined;
    const completedText = `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`;
    // Durable admission already bounds the full payload. A truncated preview
    // must never become the source of the acknowledged final document.
    const bounded = DeliveryReceipt.current()
      ? { text: completedText, truncated: false }
      : boundedTelegramStreamText(completedText);
    state.text = bounded.text;
    state.truncated = bounded.truncated;
    state.completed = true;
    state.previewClosed = true;
    state.phase = event.phase;
    if (existing?.timer) clearTimeout(existing.timer);
    state.timer = undefined;
    this.streams.delete(key);
    this.enqueue(
      chatId,
      // Reliable output owns this state even if lifecycle observation clears the live Map.
      (signal) => this.flush(chatId, key, true, state, signal, true),
      true,
      { purpose: "answer", signal: state.authorization },
    );
    return;
  }

  prepareTurnCompletion(chatId: string, threadId: string, turnId: string): (chatId: string, signal?: AbortSignal) => Promise<void> {
    this.discardUnadmittedPreviewsForTurn(chatId, threadId, turnId);
    const streams = this.streamKeysForTurn(chatId, threadId, turnId).map((key) => [key, this.streams.get(key)!] as const);
    for (const [, stream] of streams) {
      if (stream.timer) {
        clearTimeout(stream.timer);
        stream.timer = undefined;
      }
    }
    return async (chatId, signal) => {
      for (const [key, state] of streams) await this.flush(chatId, key, true, state, signal);
    };
  }

  clearTurnNotification(turnKey: string): void {
    this.notifiedTurns.delete(turnKey);
  }

  /** Revoke only this Turn's disposable previews; no final send or content retry. */
  cancelTurn(chatId: string, threadId: string, turnId: string): void {
    const turnKey = this.turnKey(threadId, turnId);
    const activityKey = this.activityKey(chatId, turnKey);
    const activity = this.activities.get(activityKey);
    if (activity) this.removeActivity(activityKey, activity);
    for (const [key, state] of this.streams) {
      if (state.chatId !== chatId || state.turnKey !== turnKey) continue;
      if (state.timer) clearTimeout(state.timer);
      state.activity?.controller.abort();
      this.streams.delete(key);
    }
    this.notifiedTurns.delete(turnKey);
  }

  prepareClose(): void {
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (!state.previewAdmitted) this.streams.delete(key);
    }
  }

  clear(): void {
    for (const state of this.streams.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.activity?.controller.abort();
    }
    for (const activity of this.activities.values()) activity.controller.abort();
    this.streams.clear();
    this.activities.clear();
    this.notifiedTurns.clear();
  }

  revalidateAccess(): void {
    for (const [key, activity] of this.activities) {
      if (activity.authorization.aborted || !this.executor.isAuthorized(activity.chatId)) this.removeActivity(key, activity);
    }
    for (const [key, state] of this.streams) {
      if (!state.authorization.aborted && this.executor.isAuthorized(state.chatId)) continue;
      if (state.timer) clearTimeout(state.timer);
      state.activity?.controller.abort();
      this.streams.delete(key);
      this.notifiedTurns.delete(state.turnKey);
    }
  }

  completeTurn(chatId: string, threadId: string, turnId: string): void {
    const turnKey = this.turnKey(threadId, turnId);
    this.activities.delete(this.activityKey(chatId, turnKey));
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
      this.enqueue(chatId, (signal) => this.flush(chatId, key, state.completed, state, signal), true, { signal: state.authorization });
    }
  }

  invalidateThread(threadId: string): void {
    for (const [key, activity] of this.activities) {
      if (activity.turnKey.startsWith(`${threadId}:`)) this.removeActivity(key, activity);
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
      this.enqueue(chatId, (signal) => this.flush(chatId, key, false, state, signal), true, { signal: state.authorization });
    }
  }

  private async flush(
    chatId: string,
    key: string,
    final: boolean,
    state: StreamState,
    signal?: AbortSignal,
    detached = false,
  ): Promise<void> {
    if (!detached && this.streams.get(key) !== state) return;
    if (!final && (!state.previewAdmitted || state.previewClosed)) return;
    signal = signal ? AbortSignal.any([signal, state.authorization]) : state.authorization;
    signal.throwIfAborted();
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
      const longMessage = planLongFinalMessage(text, this.options.finalMessageFormat ?? "html");
      if (longMessage) {
        state.messageId = await this.sendLongFinal(chatId, state, text, longMessage, signal);
        return;
      }
      {
        const format = "html";
        const formatted = formatMarkdownAsTelegramHtml(text);
        if (formatted !== undefined && (state.phase === "final_answer" || formatted !== text)) {
          try {
            state.messageId = await this.sendHtmlFinal(chatId, state, formatted, signal);
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

  private createStream(chatId: string, turnKey: string, activity?: StreamActivity): StreamState {
    return {
      chatId,
      turnKey,
      authorization: activity ? AbortSignal.any([activity.authorization, activity.controller.signal]) : this.executor.authorizationSignal(chatId),
      activity,
      text: "",
      messageId: undefined,
      creationUncertain: false,
      phase: undefined,
      previewAdmitted: false,
      previewStarted: false,
      previewClosed: false,
      completed: false,
      truncated: false,
      timer: undefined,
    };
  }

  private activityKey(chatId: string, turnKey: string): string {
    return JSON.stringify([chatId, turnKey]);
  }

  private removeActivity(key: string, activity: StreamActivity): void {
    activity.controller.abort();
    this.activities.delete(key);
    for (const [streamKey, state] of this.streams) {
      if (state.activity !== activity) continue;
      if (state.timer) clearTimeout(state.timer);
      this.streams.delete(streamKey);
    }
    this.notifiedTurns.delete(activity.turnKey);
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
    const authorization = this.executor.authorizationSignal(chatId);
    return this.delivery.enqueue(chatId, run, critical, {
      ...options,
      signal: options?.signal ? AbortSignal.any([authorization, options.signal]) : authorization,
    });
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
    if (plan.kind === "rich") {
      let firstId: number | undefined;
      for (const markdown of plan.chunks) {
        signal?.throwIfAborted();
        const part = firstId === undefined ? state : { ...state, messageId: undefined };
        try {
          part.messageId = await this.sendRichFinal(chatId, part, markdown, signal);
        } catch (error) {
          if (signal?.aborted || !isTelegramFormatRejection(error)) throw error;
          this.logger.warn({ ...surfaceDiagnosticContext(), chatId, ...telegramErrorMetadata(error) },
            "Telegram 当前富文本分段格式被拒绝，回退该段 HTML");
          part.messageId = await this.sendHtmlChunksFinal(chatId, part, formatMarkdownAsTelegramHtmlChunks(markdown), signal);
        }
        firstId ??= part.messageId;
      }
      if (firstId === undefined) throw new Error("Telegram 分段回复没有可发送内容");
      return firstId;
    }
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
      const deliver = async (text: string, formatted: boolean): Promise<void> => {
        signal?.throwIfAborted();
        const first = !deliveredChunk;
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
        deliveredChunk = true;
      };
      try {
        await deliver(html, true);
      } catch (error) {
        if (signal?.aborted || !isTelegramFormatRejection(error)) throw error;
        this.logger.warn({ ...surfaceDiagnosticContext(), chatId, chunkIndex: index,
          ...telegramErrorMetadata(error) }, "Telegram 当前分段格式被拒绝，回退该段纯文本");
        for (const part of splitTelegramPlainFallback(telegramHtmlToPlainText(html, { preserveUrls: true }))) {
          await deliver(part, false);
        }
      }
    }
    if (state.messageId === undefined) throw new Error("Telegram 分段回复没有可发送内容");
    return state.messageId;
  }


}

/** URL restoration can expand a rejected HTML chunk beyond Telegram's UTF-16 budget. */
function splitTelegramPlainFallback(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 3_500, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
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
