import { HttpError } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TelegramApiExecutor } from "../src/surfaces/telegram/api-executor.js";

describe("TelegramApiExecutor", () => {
  it("does not retry a critical request after cancellation", async () => {
    const controller = new AbortController();
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const executor = new TelegramApiExecutor(logger);
    const error = new HttpError("cancelled", new Error("aborted"));
    const operation = vi.fn(async () => {
      controller.abort();
      throw error;
    });
    await expect(executor.call(
      { chatId: "100", operation: "editMessageText", critical: true },
      operation,
      controller.signal,
    )).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "Telegram API 请求失败，稍后重试");
  });

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
