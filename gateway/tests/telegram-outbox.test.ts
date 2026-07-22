import type { Api } from "grammy";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/events.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";

const target = { surface: "telegram" as const, conversationId: "100" };

class FakeTelegramApi {
  readonly actions: string[] = [];
  readonly sent: string[] = [];
  readonly edits: string[] = [];

  async sendChatAction(_chatId: string, action: string): Promise<true> {
    this.actions.push(action);
    return true;
  }

  async sendMessage(_chatId: string, text: string): Promise<{ message_id: number }> {
    this.sent.push(text);
    return { message_id: 1 };
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

  it("renders multiple agent message items from one turn into one Telegram message", async () => {
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

    expect(api.sent).toEqual(["正在检查"]);
    expect(api.edits.at(-1)).toBe("正在检查。\n\n检查完成。");

    await outbox.close();
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
