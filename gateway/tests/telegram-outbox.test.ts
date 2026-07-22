import type { Api } from "grammy";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/events.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";

const target = { surface: "telegram" as const, conversationId: "100" };

class FakeTelegramApi {
  readonly actions: string[] = [];
  readonly sent: string[] = [];
  readonly sendOptions: unknown[] = [];
  readonly edits: string[] = [];
  private nextMessageId = 1;

  async sendChatAction(_chatId: string, action: string): Promise<true> {
    this.actions.push(action);
    return true;
  }

  async sendMessage(_chatId: string, text: string, options?: unknown): Promise<{ message_id: number }> {
    this.sent.push(text);
    this.sendOptions.push(options);
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(_chatId: string, _messageId: number, text: string): Promise<true> {
    this.edits.push(text);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TelegramOutbox", () => {
  it("keeps Telegram typing active while a turn is running and stops on completion", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    const stopRequestTyping = outbox.beginTyping(target.conversationId);
    outbox.handle(turnStarted());
    stopRequestTyping();
    await settle();
    expect(api.actions).toEqual(["typing"]);

    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(api.actions).toEqual(["typing", "typing"]);

    outbox.handle(turnCompleted());
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();
    expect(api.actions).toEqual(["typing", "typing"]);

    await outbox.close();
  });

  it("stops typing and reports a failed turn after finalizing streamed text", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.handle(textCompleted("commentary", "执行到一半。"));
    outbox.handle({
      ...turnCompleted(),
      status: "failed",
      error: "命令执行失败",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.sent).toEqual(["执行到一半。", "Codex 任务失败：命令执行失败"]);
    expect(api.actions).toEqual(["typing"]);

    await outbox.close();
  });

  it("renders each agent message item from one turn as a separate Telegram message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.handle(textDelta("commentary", "正在检查"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle(textCompleted("commentary", "正在检查。"));
    outbox.handle(textDelta("final", "检查完成。"));
    outbox.handle(textCompleted("final", "检查完成。"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["正在检查", "检查完成。"]);
    expect(api.edits.at(-1)).toBe("正在检查。");
  });

  it("renders external user input before the mirrored reply", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "user.message",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      text: "从 CLI 发来的输入\n第二行",
    });
    outbox.handle(textCompleted("final", "同步回复"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["CLI 输入\n\n│ 从 CLI 发来的输入\n│ 第二行", "同步回复"]);
    expect(api.sendOptions[1]).toMatchObject({
      reply_parameters: {
        message_id: 1,
        allow_sending_without_reply: true,
      },
    });
  });

  it("replies to the Telegram message that started the turn", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.setTurnReplyTarget("thread-1", "turn-1", 42);
    outbox.handle(textCompleted("final", "来自 Codex 的回复"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["来自 Codex 的回复"]);
    expect(api.sendOptions[0]).toMatchObject({
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
  });
});

function createOutbox(api: FakeTelegramApi): TelegramOutbox {
  return new TelegramOutbox(api as unknown as Api, pino({ level: "silent" }));
}

function turnStarted(): Extract<OutputEvent, { type: "turn.started" }> {
  return { type: "turn.started", target, threadId: "thread-1", turnId: "turn-1" };
}

function turnCompleted(): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
}

function textDelta(itemId: string, text: string): Extract<OutputEvent, { type: "text.delta" }> {
  return {
    type: "text.delta",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
  };
}

function textCompleted(itemId: string, text: string): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
