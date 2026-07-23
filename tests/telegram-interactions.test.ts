import type { Bot, Context } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { InteractionRequest } from "../src/approval/types.js";
import {
  TelegramInteractionPort,
  type TelegramInteractionQueue,
} from "../src/surfaces/telegram/interactions.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };

describe("TelegramInteractionPort", () => {
  it("removes approval buttons when another client resolves the request", async () => {
    let completeSend: ((message: { message_id: number }) => void) | undefined;
    const sendMessage = vi.fn(() => new Promise<{ message_id: number }>((resolve) => {
      completeSend = resolve;
    }));
    const editMessageText = vi.fn(async () => true as const);
    const bot = {
      callbackQuery: vi.fn(),
      api: { sendMessage, editMessageText },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));

    const decision = interactions.request(target, approvalRequest());
    interactions.resolved("request-1");
    completeSend?.({ message_id: 7 });

    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
    await settle();
    expect(editMessageText).toHaveBeenCalledWith(
      "100",
      7,
      expect.stringContaining("处理结果：已在其他客户端处理"),
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      },
    );
  });

  it("orders interaction sends and status updates through the shared queue", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 8 }));
    const editMessageText = vi.fn(async () => true as const);
    const prepareInteraction = vi.fn();
    const finishInteraction = vi.fn();
    let orderedRuns = 0;
    const queue: TelegramInteractionQueue = {
      prepareInteraction,
      finishInteraction,
      async runOrdered<T>(_chatId: string, run: () => Promise<T>): Promise<T> {
        orderedRuns += 1;
        return run();
      },
    };
    const bot = {
      callbackQuery: vi.fn(),
      api: { sendMessage, editMessageText },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(
      bot,
      pino({ level: "silent" }),
      undefined,
      queue,
    );

    const decision = interactions.request(target, approvalRequest());
    await settle();
    expect(prepareInteraction).toHaveBeenCalledWith("100", approvalRequest());
    expect(orderedRuns).toBe(1);

    interactions.resolved("request-1");
    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
    await settle();
    expect(orderedRuns).toBe(2);
    expect(editMessageText).toHaveBeenCalledOnce();
    expect(finishInteraction).toHaveBeenCalledWith(
      "100",
      approvalRequest(),
      { type: "approval", approved: false },
    );
  });

  it("requires user-input answers to reply to the ForceReply message", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 9 }));
    const editMessageText = vi.fn(async () => true as const);
    const bot = {
      callbackQuery: vi.fn(),
      api: { sendMessage, editMessageText },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));
    const decision = interactions.request(target, userInputRequest());
    await settle();

    expect(sendMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("请回复本消息"),
      expect.objectContaining({
        reply_markup: expect.objectContaining({ force_reply: true }),
      }),
    );
    expect(await interactions.handleText(textContext("普通消息"))).toBe(false);
    expect(await interactions.handleText(textContext("回答", 9))).toBe(true);
    await expect(decision).resolves.toEqual({
      type: "user-input",
      answers: { answer: ["回答"] },
    });
  });

  it("splits long approval details and only places buttons on the last chunk", async () => {
    let nextMessageId = 1;
    const sendMessage = vi.fn(async (_chatId: string, _text: string, _options?: unknown) => ({
      message_id: nextMessageId++,
    }));
    const editMessageText = vi.fn(async () => true as const);
    const bot = {
      callbackQuery: vi.fn(),
      api: { sendMessage, editMessageText },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));
    const decision = interactions.request(target, {
      ...approvalRequest(),
      detail: "x".repeat(8_000),
    });
    await settle();

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessage.mock.calls.every((call) => call[1].length <= 3_600)).toBe(true);
    expect(sendMessage.mock.calls.every((call) =>
      call[1].includes("<blockquote expandable>"),
    )).toBe(true);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({
      parse_mode: "HTML",
      disable_notification: true,
    });
    expect(sendMessage.mock.calls.at(-1)?.[2]).toHaveProperty("reply_markup");
    expect(sendMessage.mock.calls.at(-1)?.[2]).not.toHaveProperty("disable_notification");

    await interactions.close();
    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
  });

  it("allows /cancel to cancel the latest approval request", async () => {
    const bot = {
      callbackQuery: vi.fn(),
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 12 })),
        editMessageText: vi.fn(async () => true as const),
      },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));
    const decision = interactions.request(target, approvalRequest());
    await settle();

    expect(interactions.cancelForChat("100")).toBe(true);
    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
  });

  it("waits for pending approval buttons to be disabled during shutdown", async () => {
    let completeEdit: (() => void) | undefined;
    const editMessageText = vi.fn(() => new Promise<true>((resolve) => {
      completeEdit = () => resolve(true);
    }));
    const bot = {
      callbackQuery: vi.fn(),
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 13 })),
        editMessageText,
      },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));
    const decision = interactions.request(target, approvalRequest());
    await settle();

    let closed = false;
    const closing = interactions.close().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    expect(editMessageText).toHaveBeenCalledOnce();

    completeEdit?.();
    await closing;
    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
  });

  it("restores the previous ForceReply request after a newer one completes", async () => {
    let nextMessageId = 20;
    const bot = {
      callbackQuery: vi.fn(),
      api: {
        sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
        editMessageText: vi.fn(async () => true as const),
      },
    } as unknown as Bot;
    const interactions = new TelegramInteractionPort(bot, pino({ level: "silent" }));
    const first = interactions.request(target, userInputRequest("request-first"));
    const second = interactions.request(target, userInputRequest("request-second"));
    await settle();

    expect(await interactions.handleText(textContext("第二个回答", 21))).toBe(true);
    await expect(second).resolves.toEqual({
      type: "user-input",
      answers: { answer: ["第二个回答"] },
    });
    expect(await interactions.handleText(textContext("第一个回答", 20))).toBe(true);
    await expect(first).resolves.toEqual({
      type: "user-input",
      answers: { answer: ["第一个回答"] },
    });
  });
});

function approvalRequest(): Extract<InteractionRequest, { type: "approval" }> {
  return {
    type: "approval",
    requestId: "request-1",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "command-1",
    title: "Codex 请求执行命令",
    detail: "npm test",
    expiresInMs: 30_000,
  };
}

function userInputRequest(requestId = "request-input"): InteractionRequest {
  return {
    type: "user-input",
    requestId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    title: "Codex 需要输入",
    questions: [{
      id: "answer",
      header: "Answer",
      question: "请输入答案",
      options: [],
      allowOther: true,
      secret: false,
    }],
    expiresInMs: 30_000,
  };
}

function textContext(text: string, replyTo?: number): Context {
  return {
    chat: { id: 100 },
    message: {
      text,
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
    },
  } as unknown as Context;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
