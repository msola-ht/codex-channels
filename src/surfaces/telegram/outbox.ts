import { InputFile, type Api } from "grammy";
import type { InlineKeyboardMarkup, InputRichMessage } from "grammy/types";
import type { Logger } from "pino";

import type { InteractionDecision, InteractionRequest } from "../../approval/index.js";
import {
  type OperationUpdate,
  type OutputEvent,
} from "../../conversation-core/index.js";
import type { MessagePhase } from "../../codex-protocol/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { TelegramApprovalOperationCoordinator } from "./approval-operation-coordinator.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import { telegramDefaultAccountId } from "./constants.js";
import {
  formatAccountUpdate,
  formatContextUsage,
  formatMcpStatusUpdate,
  formatRateLimitUpdate,
  splitTelegramText,
} from "./format.js";
import { formatMarkdownAsTelegramHtml } from "./markdown-format.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import {
  planLongFinalMessage,
  splitExpandableMessage,
  type LongFinalMessagePlan,
} from "./long-message-format.js";
import { formatOperationLog } from "./operation-format.js";
import { TelegramTypingIndicator } from "./typing-indicator.js";

interface StreamState {
  chatId: string;
  turnKey: string;
  text: string;
  messageId: number | undefined;
  phase: MessagePhase | null | undefined;
  completed: boolean;
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

const maximumRichMarkdownCharacters = 32_000;

export type TelegramFinalMessageFormat = "html" | "rich";

export interface TelegramOutboxOptions {
  finalMessageFormat?: TelegramFinalMessageFormat;
  accountId?: string;
}

export class TelegramOutbox {
  private readonly streams = new Map<string, StreamState>();
  private readonly operationLogs = new Map<string, OperationLogState>();
  private readonly replyToByTurn = new Map<string, number>();
  private readonly typing: TelegramTypingIndicator;
  private readonly delivery: ConversationDeliveryQueue;
  private readonly approvalOperations = new TelegramApprovalOperationCoordinator();
  private readonly notifiedTurns = new Set<string>();
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

  setTurnReplyTarget(threadId: string, turnId: string, messageId: number): void {
    if (this.closed) {
      return;
    }
    this.replyToByTurn.set(this.turnKey(threadId, turnId), messageId);
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
        this.typing.start(chatId, this.turnActivityKey(event.threadId, event.turnId));
        return;
      case "user.message": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.enqueue(chatId, async () => {
          const messageId = await this.sendPanel(
            chatId,
            formatCliInput(event.text),
            undefined,
            true,
          );
          if (messageId !== undefined) {
            this.replyToByTurn.set(turnKey, messageId);
          }
        }, true);
        return;
      }
      case "text.delta": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const key = this.streamKey(turnKey, event.itemId);
        const existing = this.streams.get(key);
        if (!existing) {
          this.sealOperationLog(chatId, turnKey);
        }
        const state = existing ?? this.createStream(chatId, turnKey);
        state.text += event.text;
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
        this.sealOperationLog(chatId, turnKey);
        const key = this.streamKey(turnKey, event.itemId);
        const state = this.streams.get(key) ?? this.createStream(chatId, turnKey);
        state.text = event.text;
        state.completed = true;
        if (event.phase !== undefined) {
          state.phase = event.phase;
        }
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        this.streams.set(key, state);
        this.enqueue(chatId, () => this.flush(chatId, key, true), true);
        return;
      }
      case "operation.updated": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
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
      case "turn.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
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
        this.enqueue(chatId, async () => {
          for (const key of keys) {
            await this.flush(chatId, key, true);
          }
          const replyTo = this.replyToByTurn.get(turnKey);
          if (event.error) {
            await this.send(
              chatId,
              "Codex 任务失败，Gateway 已隐藏上游错误详情以避免泄露敏感信息。",
              replyTo,
            );
          } else if (!new Set(["completed", "success"]).has(event.status)) {
            await this.send(chatId, `Codex 任务状态：${event.status}`, replyTo);
          }
          if (event.tokenUsage) {
            await this.sendPanel(
              chatId,
              formatContextUsage(
                event.tokenUsage,
                event.model
                  ? {
                      model: event.model,
                      effort: event.effort ?? null,
                      serviceTier: event.serviceTier ?? null,
                      ...(event.weeklyLimit ? { weeklyLimit: event.weeklyLimit } : {}),
                    }
                  : undefined,
              ),
              undefined,
              true,
            );
          }
          this.replyToByTurn.delete(turnKey);
          this.notifiedTurns.delete(turnKey);
          this.clearApprovalOperationsForTurn(turnKey);
        }, true);
        return;
      }
      case "warning":
        this.enqueue(chatId, async () => {
          await this.send(
            chatId,
            "Codex 发出一条警告，Gateway 已隐藏上游详情。",
            undefined,
            true,
          );
        }, true);
        return;
      case "connection.lost":
        this.clearThreadOutput(chatId, event.threadId);
        this.enqueue(chatId, async () => {
          await this.send(chatId, `Codex 警告：${event.message}`);
        }, true);
        return;
      case "account.updated":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatAccountUpdate(event.authMode, event.planType),
            undefined,
            true,
          );
        }, true);
        return;
      case "account.rateLimits.updated":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatRateLimitUpdate(event.rateLimits),
            undefined,
            true,
          );
        }, true);
        return;
      case "mcp.status.updated":
        this.enqueue(chatId, async () => {
          await this.sendPanel(
            chatId,
            formatMcpStatusUpdate(event),
            undefined,
            event.status !== "failed",
          );
        }, event.status === "failed");
        return;
      case "thread.status":
        return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
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
    this.replyToByTurn.clear();
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

  private async flush(chatId: string, key: string, final: boolean): Promise<void> {
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    if (!state.text.trim()) {
      if (final) {
        this.streams.delete(key);
      }
      return;
    }
    const text = state.text.trimEnd();
    if (final && state.phase !== "commentary") {
      const longMessage = planLongFinalMessage(text);
      if (longMessage) {
        try {
          state.messageId = await this.sendLongFinal(chatId, state, text, longMessage);
          this.streams.delete(key);
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
            this.streams.delete(key);
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
      this.streams.delete(key);
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
    const text = formatOperationLog(state);
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
            this.replyToByTurn.get(turnKey),
          );
        }
      }
    } else {
      state.messageId = await this.sendOperationMessage(
        chatId,
        text,
        this.replyToByTurn.get(turnKey),
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
      : this.replyToByTurn.get(state.turnKey);
    const silent = state.phase === "commentary" || this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo, silent)),
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    if (replyTo !== undefined) {
      this.replyToByTurn.delete(state.turnKey);
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

    const replyTo = this.replyToByTurn.get(state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendRichMessage", critical: true },
      () => this.api.sendRichMessage(chatId, richMessage, richReplyOptions(replyTo, silent)),
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    if (replyTo !== undefined) {
      this.replyToByTurn.delete(state.turnKey);
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

    const replyTo = this.replyToByTurn.get(state.turnKey);
    const silent = this.notifiedTurns.has(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, html, htmlSendOptions(replyTo, silent)),
    );
    if (!silent) {
      this.notifiedTurns.add(state.turnKey);
    }
    if (replyTo !== undefined) {
      this.replyToByTurn.delete(state.turnKey);
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
      const replyTo = this.replyToByTurn.get(state.turnKey);
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
        this.replyToByTurn.delete(state.turnKey);
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
    return state.messageId!;
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
    for (const key of this.replyToByTurn.keys()) {
      if (key.startsWith(`${threadId}:`)) {
        this.replyToByTurn.delete(key);
      }
    }
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

function formatCliInput(text: string): string {
  const quote = text
    .trim()
    .split("\n")
    .map((line) => `│ ${line}`)
    .join("\n");
  return `CLI 输入\n\n${quote}`;
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
