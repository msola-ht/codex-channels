import type { Bot } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TelegramLifecycle } from "../src/surfaces/telegram/lifecycle.js";

describe("TelegramLifecycle", () => {
  it("initializes the bot, registers commands and stops long polling by aborting it", async () => {
    const calls: string[] = [];
    let registeredCommands: ReadonlyArray<{ command: string }> = [];
    const notificationOptions: unknown[] = [];
    const failures: Error[] = [];
    const bot = {
      botInfo: { username: "test_bot" },
      init: async () => {
        calls.push("init");
      },
      handleUpdate: async () => undefined,
      api: {
        setMyCommands: async (commands: ReadonlyArray<{ command: string }>) => {
          calls.push("commands");
          registeredCommands = commands;
          return true;
        },
        sendMessage: async (chatId: number, text: string, options?: unknown) => {
          calls.push(`notify:${chatId}:${text}`);
          notificationOptions.push(options);
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
      {
        messages: () => {
          calls.push("messages");
          return [{ chatId: 123, text: "Gateway 已联通" }];
        },
      },
      (error) => failures.push(error),
    );

    lifecycle.start();
    await vi.waitFor(() => expect(calls).toContain("poll"));
    await lifecycle.stop();

    expect(calls).toEqual(["init", "commands", "messages", "notify:123:<b>Gateway 已联通</b>", "poll"]);
    expect(notificationOptions).toEqual([{
      parse_mode: "HTML",
      disable_notification: true,
    }]);
    expect(failures).toEqual([]);
    expect(registeredCommands.some((command) => command.command === "fast")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "sessions")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "diff")).toBe(true);
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
      { messages: () => [{ chatId: 123, text: "Gateway 已联通" }] },
    );

    lifecycle.start();
    await vi.waitFor(() => expect(polling).toBe(true));
    await lifecycle.stop();
  });

  it("keeps polling when startup notification generation fails", async () => {
    let polling = false;
    const bot = {
      botInfo: { username: "test_bot" },
      init: async () => undefined,
      handleUpdate: async () => undefined,
      api: {
        setMyCommands: async () => true,
        sendMessage: async () => ({ message_id: 1 }),
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
      {
        messages: () => {
          throw new Error("status unavailable");
        },
      },
    );

    lifecycle.start();
    await vi.waitFor(() => expect(polling).toBe(true));
    await lifecycle.stop();
  });

  it("reports a fatal failure after long polling retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      let pollingAttempts = 0;
      const failures: Error[] = [];
      const bot = {
        botInfo: { username: "test_bot" },
        init: async () => undefined,
        handleUpdate: async () => undefined,
        api: {
          setMyCommands: async () => true,
          getUpdates: async () => {
            pollingAttempts += 1;
            throw new Error("network unavailable");
          },
        },
      };
      const lifecycle = new TelegramLifecycle(
        bot as unknown as Bot,
        pino({ level: "silent" }),
        undefined,
        (error) => failures.push(error),
      );

      lifecycle.start();
      await vi.runAllTimersAsync();

      expect(pollingAttempts).toBe(12);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain("连续失败 12 次");
      await lifecycle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
