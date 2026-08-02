import type { Bot } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  TelegramLifecycle,
  telegramUpdateGroupSize,
} from "../src/surfaces/telegram/lifecycle.js";

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
    expect(registeredCommands.some((command) => command.command === "queue")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "sessions")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "diff")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "rules")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "stop")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "vision")).toBe(true);
    expect(registeredCommands.some((command) => command.command === "cancel")).toBe(false);
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

  it("does not reorder an update between non-contiguous media groups", async () => {
    const handled: number[] = [];
    let delivered = false;
    const bot = {
      botInfo: { username: "test_bot" },
      init: async () => undefined,
      handleUpdate: async (update: { update_id: number }) => {
        handled.push(update.update_id);
      },
      api: {
        setMyCommands: async () => true,
        getUpdates: async (_options: unknown, signal: AbortSignal) => {
          if (!delivered) {
            delivered = true;
            return [
              telegramUpdate(1, "album"),
              telegramUpdate(2),
              telegramUpdate(3, "album"),
            ];
          }
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
    await vi.waitFor(() => expect(handled).toHaveLength(3));
    await lifecycle.stop();

    expect(handled).toEqual([1, 2, 3]);
  });

  it("exposes the size of one contiguous media group while handling it", async () => {
    const handled: Array<[number, number | undefined]> = [];
    let delivered = false;
    const bot = {
      botInfo: { username: "test_bot" },
      init: async () => undefined,
      handleUpdate: async (update: ReturnType<typeof telegramUpdate>) => {
        handled.push([update.update_id, telegramUpdateGroupSize(update)]);
      },
      api: {
        setMyCommands: async () => true,
        getUpdates: async (_options: unknown, signal: AbortSignal) => {
          if (!delivered) {
            delivered = true;
            return [telegramUpdate(1, "album"), telegramUpdate(2, "album")];
          }
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
    await vi.waitFor(() => expect(handled).toHaveLength(2));
    await lifecycle.stop();

    expect(handled).toEqual([[1, 2], [2, 2]]);
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
      let recovering = false;
      const failures: Error[] = [];
      const bot = {
        botInfo: { username: "test_bot" },
        init: async () => undefined,
        handleUpdate: async () => undefined,
        api: {
          setMyCommands: async () => true,
          getUpdates: async (_options: unknown, signal?: AbortSignal) => {
            pollingAttempts += 1;
            if (recovering && signal) {
              return await new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => reject(signal.reason),
                  { once: true },
                );
              });
            }
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
      recovering = true;
      lifecycle.start();
      await vi.waitFor(() => expect(pollingAttempts).toBe(13));
      await lifecycle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function telegramUpdate(updateId: number, mediaGroupId?: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1, type: "private" as const },
      ...(mediaGroupId === undefined
        ? { text: "middle" }
        : {
            media_group_id: mediaGroupId,
            photo: [{
              file_id: `photo-${updateId}`,
              file_unique_id: `unique-${updateId}`,
              width: 10,
              height: 10,
            }],
          }),
    },
  };
}
