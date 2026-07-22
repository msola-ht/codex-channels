import type { Api } from "grammy";
import type { Logger } from "pino";

import type { OutputEvent } from "../../conversation-core/events.js";
import type { MessagePhase } from "../../codex-protocol/index.js";
import { BoundedAsyncQueue } from "../../event-bus/bounded-queue.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { splitTelegramText } from "./format.js";

interface StreamState {
  chatId: string;
  turnKey: string;
  text: string;
  messageId: number | undefined;
  phase: MessagePhase | null | undefined;
  completed: boolean;
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
    private readonly executor = new TelegramApiExecutor(logger),
  ) {}

  setTurnReplyTarget(threadId: string, turnId: string, messageId: number): void {
    if (this.closed) {
      return;
    }
    this.replyToByTurn.set(this.turnKey(threadId, turnId), messageId);
  }

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
        const state = this.streams.get(key) ?? this.createStream(chatId, turnKey);
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
        const key = this.streamKey(turnKey, event.itemId);
        const state = this.streams.get(key) ?? this.createStream(chatId, turnKey);
        state.text = event.text;
        state.completed = true;
        if (event.phase !== undefined) {
          state.phase = event.phase;
        }
        if (state.timer) {
          clearTimeout(state.timer);
        }
        state.timer = setTimeout(() => {
          state.timer = undefined;
          this.enqueue(chatId, () => this.flush(chatId, key, true), true);
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
      case "connection.lost":
        this.clearThreadOutput(chatId, event.threadId);
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
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.completed) {
        this.enqueue(state.chatId, () => this.flush(state.chatId, key, true), true);
      }
    }
    for (const state of this.typing.values()) {
      clearTimeout(state.timer);
    }
    for (const worker of this.workers.values()) {
      worker.queue.close();
    }
    const workers = Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
    await waitAtMost(workers, 5_000);
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
      await this.executor.call(
        { chatId, operation: "sendChatAction", critical: false },
        () => this.api.sendChatAction(chatId, "typing"),
      );
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
      try {
        await operation.run();
      } catch (error) {
        this.logger.warn(
          { error: safeErrorMessage(error), chatId, critical: operation.critical },
          "Telegram 输出失败",
        );
      }
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
        await this.sendMessage(chatId, chunk);
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

  private startTyping(chatId: string, activityKey: string): void {
    const current = this.typing.get(chatId);
    if (current) {
      current.activityKeys.add(activityKey);
      return;
    }
    const timer = setTimeout(() => this.refreshTyping(chatId), 400);
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
      const messageId = await this.sendMessage(
        chatId,
        chunk,
        firstMessageId === undefined ? replyTo : undefined,
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

  private async sendFirstChunk(chatId: string, state: StreamState, text: string): Promise<number> {
    const replyTo = state.phase === "commentary"
      ? undefined
      : this.replyToByTurn.get(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo)),
    );
    if (replyTo !== undefined) {
      this.replyToByTurn.delete(state.turnKey);
    }
    return message.message_id;
  }

  private async sendMessage(chatId: string, text: string, replyTo?: number): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo)),
    );
    return message.message_id;
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
    for (const key of this.replyToByTurn.keys()) {
      if (key.startsWith(`${threadId}:`)) {
        this.replyToByTurn.delete(key);
      }
    }
    const typing = this.typing.get(chatId);
    if (typing) {
      clearTimeout(typing.timer);
      this.typing.delete(chatId);
    }
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

function replyOptions(replyTo?: number): Parameters<Api["sendMessage"]>[2] {
  return replyTo === undefined
    ? {}
    : {
        reply_parameters: {
          message_id: replyTo,
          allow_sending_without_reply: true,
        },
      };
}

function isMessageNotModified(error: unknown): boolean {
  return safeErrorMessage(error).toLowerCase().includes("message is not modified");
}

async function waitAtMost<T>(operation: Promise<T>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
