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
    );

    lifecycle.start();
    await vi.waitFor(() => expect(calls).toContain("poll"));
    await lifecycle.stop();

    expect(calls).toEqual(["init", "commands", "poll"]);
  });
});
