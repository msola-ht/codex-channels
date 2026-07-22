import type { Bot } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TelegramLifecycle } from "../src/surfaces/telegram/lifecycle.js";

describe("TelegramLifecycle", () => {
  it("initializes the bot, registers commands and stops long polling by aborting it", async () => {
    const calls: string[] = [];
    const bot = {
      botInfo: { username: "test_bot" },
      init: async () => {
        calls.push("init");
      },
      handleUpdate: async () => undefined,
      api: {
        setMyCommands: async () => {
          calls.push("commands");
          return true;
        },
        sendMessage: async (chatId: number, text: string) => {
          calls.push(`notify:${chatId}:${text}`);
          return { message_id: 1 };
        },
        getUpdates: async (_options: unknown, signal: AbortSignal) => {
          calls.push("poll");
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return [];
        },
      },
    };
    const lifecycle = new TelegramLifecycle(
      bot as unknown as Bot,
      pino({ level: "silent" }),
      { messages: [{ chatId: 123, text: "Gateway 已联通" }] },
    );

    lifecycle.start();
    await vi.waitFor(() => expect(calls).toContain("poll"));
    await lifecycle.stop();

    expect(calls).toEqual(["init", "commands", "notify:123:Gateway 已联通", "poll"]);
  });

  it("keeps polling when a startup notification cannot be delivered", async () => {
    let polling = false;
    const bot = {
      botInfo: { username: "test_bot" },
      init: async () => undefined,
      handleUpdate: async () => undefined,
      api: {
        setMyCommands: async () => true,
        sendMessage: async () => {
          throw new Error("chat unavailable");
        },
        getUpdates: async (_options: unknown, signal: AbortSignal) => {
          polling = true;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return [];
        },
      },
    };
    const lifecycle = new TelegramLifecycle(
      bot as unknown as Bot,
      pino({ level: "silent" }),
      { messages: [{ chatId: 123, text: "Gateway 已联通" }] },
    );

    lifecycle.start();
    await vi.waitFor(() => expect(polling).toBe(true));
    await lifecycle.stop();
  });
});
