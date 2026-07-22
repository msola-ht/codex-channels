import type { Api } from "grammy";
import type { Logger } from "pino";

import type { OutputEvent } from "../../conversation-core/events.js";
import { BoundedAsyncQueue } from "../../event-bus/bounded-queue.js";
import { splitTelegramText } from "./format.js";

interface StreamState {
  chatId: string;
  text: string;
  messageId: number | undefined;
  timer: NodeJS.Timeout | undefined;
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
  private readonly workers = new Map<string, ChatWorker>();
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
      case "text.delta": {
        const key = this.streamKey(event.threadId, event.turnId, event.itemId);
        const state = this.streams.get(key) ?? { chatId, text: "", messageId: undefined, timer: undefined };
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
        const key = this.streamKey(event.threadId, event.turnId, event.itemId);
        const state = this.streams.get(key) ?? { chatId, text: "", messageId: undefined, timer: undefined };
        state.text = event.text;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        this.streams.set(key, state);
        this.enqueue(chatId, () => this.flush(chatId, key, true), true);
        return;
      }
      case "turn.completed": {
        if (event.error) {
          this.enqueue(chatId, () => this.send(chatId, `Codex 任务失败：${event.error}`), true);
        } else if (!new Set(["completed", "success"]).has(event.status)) {
          this.enqueue(chatId, () => this.send(chatId, `Codex 任务状态：${event.status}`), true);
        }
        return;
      }
      case "warning":
        this.enqueue(chatId, () => this.send(chatId, `Codex 警告：${event.message}`), true);
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
    for (const worker of this.workers.values()) {
      worker.queue.close();
    }
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
    this.streams.clear();
    this.workers.clear();
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
    if (!state?.text) {
      return;
    }
    const [first, ...rest] = splitTelegramText(state.text);
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
      const message = await this.api.sendMessage(chatId, first);
      state.messageId = message.message_id;
    }
    if (final) {
      for (const chunk of rest) {
        await this.api.sendMessage(chatId, chunk);
      }
      this.streams.delete(key);
    }
  }

  private async send(chatId: string, text: string): Promise<void> {
    for (const chunk of splitTelegramText(text)) {
      await this.api.sendMessage(chatId, chunk);
    }
  }

  private streamKey(threadId: string, turnId: string, itemId: string): string {
    return `${threadId}:${turnId}:${itemId}`;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
