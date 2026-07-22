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
    await vi.advanceTimersByTimeAsync(400);
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
    expect(api.actions).toEqual([]);

    await outbox.close();
  });

  it("renders each agent message item from one turn as a separate Telegram message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.setTurnReplyTarget("thread-1", "turn-1", 42);
    outbox.handle(textDelta("commentary", "正在检查", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle(textCompleted("commentary", "正在检查。", "commentary"));
    outbox.handle(textDelta("final", "检查完成。", "final_answer"));
    outbox.handle(textCompleted("final", "检查完成。", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["正在检查", "检查完成。"]);
    expect(api.edits).toContain("正在检查。");
    expect(api.sendOptions[0]).toEqual({});
    expect(api.sendOptions[1]).toMatchObject({
      reply_parameters: { message_id: 42 },
    });
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
    outbox.handle(textCompleted("final-1", "来自 Codex 的回复", "final_answer"));
    outbox.handle(textCompleted("final-2", "补充说明", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["来自 Codex 的回复", "补充说明"]);
    expect(api.sendOptions[0]).toMatchObject({
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
    expect(api.sendOptions[1]).toEqual({});
  });

  it("finalizes completed stream content during graceful shutdown", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "关闭前已经完成", "final_answer"));
    await outbox.close();

    expect(api.sent).toEqual(["关闭前已经完成"]);
  });

  it("does not persist an incomplete stream during graceful shutdown", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("final", "仍在生成", "final_answer"));
    await outbox.close();

    expect(api.sent).toEqual([]);
  });

  it("clears pending typing and stream output after the App Server disconnects", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    await vi.advanceTimersByTimeAsync(400);
    outbox.handle(textDelta("commentary", "尚未完成", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle({
      type: "connection.lost",
      target,
      threadId: "thread-1",
      message: "连接已断开",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.actions).toEqual(["typing"]);
    expect(api.sent).toEqual(["尚未完成", "Codex 警告：连接已断开"]);

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

function textDelta(
  itemId: string,
  text: string,
  phase?: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.delta" }> {
  return {
    type: "text.delta",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
    ...(phase ? { phase } : {}),
  };
}

function textCompleted(
  itemId: string,
  text: string,
  phase?: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
    ...(phase ? { phase } : {}),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
