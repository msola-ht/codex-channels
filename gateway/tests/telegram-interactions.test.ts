import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { InteractionRequest } from "../src/approval/types.js";
import { TelegramInteractionPort } from "../src/surfaces/telegram/interactions.js";

const target = { surface: "telegram" as const, conversationId: "100" };

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
    const interactions = new TelegramInteractionPort(bot);

    const decision = interactions.request(target, approvalRequest());
    interactions.resolved("request-1");
    completeSend?.({ message_id: 7 });

    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
    await settle();
    expect(editMessageText).toHaveBeenCalledWith(
      "100",
      7,
      expect.stringContaining("处理结果：已在其他客户端处理"),
      { reply_markup: { inline_keyboard: [] } },
    );
  });
});

function approvalRequest(): InteractionRequest {
  return {
    type: "approval",
    requestId: "request-1",
    kind: "command",
    title: "Codex 请求执行命令",
    detail: "npm test",
    expiresInMs: 30_000,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
