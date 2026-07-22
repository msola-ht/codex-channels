import { HttpError } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TelegramApiExecutor } from "../src/surfaces/telegram/api-executor.js";

describe("TelegramApiExecutor", () => {
  it("retries transient failures for critical messages", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const operation = vi.fn()
      .mockRejectedValueOnce(new HttpError("network failed", new Error("timeout")))
      .mockResolvedValue("ok");

    const result = executor.call(
      { chatId: "100", operation: "sendMessage", critical: true },
      operation,
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not retry transient typing failures", async () => {
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const error = new HttpError("network failed", new Error("timeout"));
    const operation = vi.fn().mockRejectedValue(error);

    await expect(executor.call(
      { chatId: "100", operation: "sendChatAction", critical: false },
      operation,
    )).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
