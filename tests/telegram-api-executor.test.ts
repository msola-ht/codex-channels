import { GrammyError, HttpError } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TelegramApiExecutor } from "../src/surfaces/telegram/api-executor.js";
import { captureDelivery, type DeliveryCheckpoint } from "../src/surfaces/delivery-receipt.js";
import { ConversationDeliveryQueue } from "../src/surfaces/conversation-delivery-queue.js";

describe("TelegramApiExecutor", () => {
  it.each(["unchanged", "network-text", "other-400", "wrong-method", "cancelled"] as const)("settles only verified unchanged edits as confirmed (%s)", async (mode) => {
    const logger = pino({ level: "silent" });
    const executor = new TelegramApiExecutor(logger);
    const queue = new ConversationDeliveryQueue(logger, { component: "Test" });
    const checkpoints: DeliveryCheckpoint[] = [];
    const controller = new AbortController();
    const error = mode === "network-text" ? new Error("message is not modified") : new GrammyError("fixture", {
      ok: false, error_code: 400, description: mode === "other-400" ? "Bad Request: message to edit not found" : "Bad Request: message is not modified",
    }, mode === "wrong-method" ? "sendMessage" : "editMessageText", {});
    const operation = vi.fn(async () => { if (mode === "cancelled") controller.abort(); throw error; });
    try {
      const result = captureDelivery(() => { queue.enqueue("chat", () => executor.editMessageText(
        { chatId: "chat", critical: true }, operation, controller.signal,
      ), true); }, controller.signal, async (value) => { checkpoints.push(value); }, { requireConfirmation: true });
      if (mode === "unchanged") await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow();
      await queue.waitForIdle();
      expect(operation).toHaveBeenCalledOnce();
      expect(checkpoints.filter((value) => value.state === "confirmed")).toHaveLength(mode === "unchanged" ? 1 : 0);
    } finally { await queue.close(); }
  });

  it.each(["sendMessage", "sendRichMessage", "sendDocument", "sendPhoto"])("does not retry ambiguous %s writes", async (method) => {
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    for (const error of [new HttpError("lost", new Error("timeout")), new GrammyError("server", {
      ok: false, error_code: 500, description: "Internal error",
    }, method, {})]) {
      const operation = vi.fn().mockRejectedValue(error);
      await expect(executor.call({ chatId: "100", operation: method, critical: true }, operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledOnce();
    }
  });

  it("retries explicitly rate-limited new messages", async () => {
    vi.useFakeTimers();
    try {
      const operation = vi.fn().mockRejectedValueOnce(new GrammyError("limited", {
        ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 },
      }, "sendMessage", {})).mockResolvedValue("ok");
      const result = new TelegramApiExecutor(pino({ level: "silent" })).call(
        { chatId: "100", operation: "sendMessage", critical: true }, operation);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

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
    await expect(executor.editMessageText(
      { chatId: "100", critical: true },
      operation,
      controller.signal,
    )).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "Telegram API 请求失败，稍后重试");
  });

  it("retries transient failures for idempotent edits", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const operation = vi.fn()
      .mockRejectedValueOnce(new HttpError("network failed", new Error("timeout")))
      .mockResolvedValue("ok");

    const result = executor.editMessageText(
      { chatId: "100", critical: true },
      operation,
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeUndefined();
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
