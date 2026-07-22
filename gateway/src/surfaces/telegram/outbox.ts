import type { Api } from "grammy";
import type { Logger } from "pino";

import type { OutputEvent } from "../../conversation-core/events.js";
import { BoundedAsyncQueue } from "../../event-bus/bounded-queue.js";
import { splitTelegramText } from "./format.js";

interface StreamState {
  turnKey: string;
  text: string;
  messageId: number | undefined;
  timer: NodeJS.Timeout | undefined;
}

interface TypingState {
  activityKeys: Set<string>;
  timer: NodeJS.Timeout;
}

interface OutboxOperation {
  critical: boolean;
  run(): Promise<void>;
}

interface ChatWorker {
  queue: BoundedAsyncQueue<OutboxOperation>;
  done: Promise<void>;
}

export class TelegramOutbox {
  private readonly streams = new Map<string, StreamState>();
  private readonly replyToByTurn = new Map<string, number>();
  private readonly typing = new Map<string, TypingState>();
  private readonly lastTypingAt = new Map<string, number>();
  private readonly workers = new Map<string, ChatWorker>();
  private nextActivityId = 1;
  private closed = false;

  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
  ) {}

  handle(event: OutputEvent): void {
    if (this.closed) {
      return;
    }
    const chatId = event.target.conversationId;
    switch (event.type) {
      case "turn.started":
        this.startTyping(chatId, this.turnActivityKey(event.threadId, event.turnId));
        return;
      case "user.message": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.enqueue(chatId, async () => {
          const messageId = await this.send(chatId, formatCliInput(event.text));
          if (messageId !== undefined) {
            this.replyToByTurn.set(turnKey, messageId);
          }
        }, true);
        return;
      }
      case "text.delta": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const key = this.streamKey(turnKey, event.itemId);
        const state = this.streams.get(key) ?? this.createStream(turnKey);
        state.text += event.text;
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
        const key = this.streamKey(turnKey, event.itemId);
        const state = this.streams.get(key) ?? this.createStream(turnKey);
        state.text = event.text;
        if (state.timer) {
          clearTimeout(state.timer);
        }
        state.timer = setTimeout(() => {
          state.timer = undefined;
          this.enqueue(chatId, () => this.flush(chatId, key, false), true);
        }, 100);
        state.timer.unref();
        this.streams.set(key, state);
        return;
      }
      case "turn.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const keys = this.streamKeysForTurn(event.threadId, event.turnId);
        for (const key of keys) {
          const stream = this.streams.get(key);
          if (stream?.timer) {
            clearTimeout(stream.timer);
            stream.timer = undefined;
          }
        }
        this.stopTyping(chatId, this.turnActivityKey(event.threadId, event.turnId));
        this.enqueue(chatId, async () => {
          for (const key of keys) {
            await this.flush(chatId, key, true);
          }
          const replyTo = this.replyToByTurn.get(turnKey);
          if (event.error) {
            await this.send(chatId, `Codex 任务失败：${event.error}`, replyTo);
          } else if (!new Set(["completed", "success"]).has(event.status)) {
            await this.send(chatId, `Codex 任务状态：${event.status}`, replyTo);
          }
          this.replyToByTurn.delete(turnKey);
        }, true);
        return;
      }
      case "warning":
        this.enqueue(chatId, async () => {
          await this.send(chatId, `Codex 警告：${event.message}`);
        }, true);
        return;
      case "thread.status":
        return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const state of this.streams.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    for (const state of this.typing.values()) {
      clearTimeout(state.timer);
    }
    for (const worker of this.workers.values()) {
      worker.queue.close();
    }
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
    this.streams.clear();
    this.replyToByTurn.clear();
    this.typing.clear();
    this.lastTypingAt.clear();
    this.workers.clear();
  }

  showTyping(chatId: string): void {
    if (this.closed) {
      return;
    }
    const now = Date.now();
    if (now - (this.lastTypingAt.get(chatId) ?? 0) < 1_000) {
      return;
    }
    this.lastTypingAt.set(chatId, now);
    this.enqueue(chatId, async () => {
      await this.api.sendChatAction(chatId, "typing");
    }, false);
  }

  beginTyping(chatId: string): () => void {
    if (this.closed) {
      return () => undefined;
    }
    const activityKey = `request:${this.nextActivityId++}`;
    this.startTyping(chatId, activityKey);
    return () => this.stopTyping(chatId, activityKey);
  }

  private enqueue(chatId: string, run: () => Promise<void>, critical: boolean): void {
    let worker = this.workers.get(chatId);
    if (!worker) {
      const queue = new BoundedAsyncQueue<OutboxOperation>(200);
      worker = { queue, done: this.runWorker(chatId, queue) };
      this.workers.set(chatId, worker);
    }
    if (!worker.queue.push({ critical, run }, critical)) {
      this.logger.warn({ chatId, critical }, "Telegram Outbox 已满，输出未入队");
    }
  }

  private async runWorker(
    chatId: string,
    queue: BoundedAsyncQueue<OutboxOperation>,
  ): Promise<void> {
    while (true) {
      const operation = await queue.shift();
      if (!operation) {
        return;
      }
      const attempts = operation.critical ? 3 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await operation.run();
          break;
        } catch (error) {
          if (attempt === attempts) {
            this.logger.warn(
              { error: safeErrorMessage(error), chatId, critical: operation.critical, attempts },
              "Telegram 输出失败",
            );
            break;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
            timer.unref();
          });
        }
      }
    }
  }

  private async flush(chatId: string, key: string, final: boolean): Promise<void> {
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    const text = state.text.trim();
    if (!text) {
      if (final) {
        this.streams.delete(key);
      }
      return;
    }
    const [first, ...rest] = splitTelegramText(text);
    if (!first) {
      return;
    }
    if (state.messageId) {
      try {
        await this.api.editMessageText(chatId, state.messageId, first);
      } catch (error) {
        if (!String(error).toLowerCase().includes("message is not modified")) {
          throw error;
        }
      }
    } else {
      const replyTo = this.replyToByTurn.get(state.turnKey);
      const message = await this.api.sendMessage(
        chatId,
        first,
        replyTo === undefined
          ? {}
          : {
              reply_parameters: {
                message_id: replyTo,
                allow_sending_without_reply: true,
              },
            },
      );
      state.messageId = message.message_id;
      if (replyTo !== undefined) {
        this.replyToByTurn.delete(state.turnKey);
      }
    }
    if (final) {
      for (const chunk of rest) {
        await this.api.sendMessage(chatId, chunk);
      }
      this.streams.delete(key);
    }
  }

  private createStream(turnKey: string): StreamState {
    return {
      turnKey,
      text: "",
      messageId: undefined,
      timer: undefined,
    };
  }

  private startTyping(chatId: string, activityKey: string): void {
    const current = this.typing.get(chatId);
    if (current) {
      current.activityKeys.add(activityKey);
      return;
    }
    this.showTyping(chatId);
    const timer = setTimeout(() => this.refreshTyping(chatId), 4_000);
    timer.unref();
    this.typing.set(chatId, { activityKeys: new Set([activityKey]), timer });
  }

  private refreshTyping(chatId: string): void {
    const state = this.typing.get(chatId);
    if (!state || state.activityKeys.size === 0 || this.closed) {
      return;
    }
    this.showTyping(chatId);
    const timer = setTimeout(() => this.refreshTyping(chatId), 4_000);
    timer.unref();
    state.timer = timer;
  }

  private stopTyping(chatId: string, activityKey: string): void {
    const state = this.typing.get(chatId);
    if (!state) {
      return;
    }
    state.activityKeys.delete(activityKey);
    if (state.activityKeys.size === 0) {
      clearTimeout(state.timer);
      this.typing.delete(chatId);
    }
  }

  private async send(chatId: string, text: string, replyTo?: number): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of splitTelegramText(text)) {
      const message = await this.api.sendMessage(
        chatId,
        chunk,
        firstMessageId === undefined && replyTo !== undefined
          ? {
              reply_parameters: {
                message_id: replyTo,
                allow_sending_without_reply: true,
              },
            }
          : {},
      );
      firstMessageId ??= message.message_id;
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
}

function formatCliInput(text: string): string {
  const quote = text
    .trim()
    .split("\n")
    .map((line) => `│ ${line}`)
    .join("\n");
  return `CLI 输入\n\n${quote}`;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
