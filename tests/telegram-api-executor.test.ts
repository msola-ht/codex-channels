import { GrammyError, HttpError } from "grammy";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramApiExecutor } from "../src/surfaces/telegram/api-executor.js";

describe("TelegramApiExecutor", () => {
  afterEach(() => vi.useRealTimers());
  it("retries transient failures for critical messages", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const operation = vi.fn()
      .mockRejectedValueOnce(new HttpError("network failed", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })))
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

  it("recovers a critical send after more than three connection failures", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const error = new HttpError("secret", Object.assign(new Error("secret"), { code: "ECONNREFUSED" }));
    const operation = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue("ok");
    const result = executor.call({ chatId: "100", operation: "sendMessage", critical: true }, operation);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it("times out progress promptly even when the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    let signal: AbortSignal | undefined;
    const operation = vi.fn((value: AbortSignal) => { signal = value; return new Promise(() => {}); });
    const checked = expect(executor.call({ chatId: "100", operation: "editMessageText", critical: false }, operation))
      .rejects.toMatchObject({ code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
    expect(signal?.aborted).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated stalled edits by the total recovery deadline", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const signals: AbortSignal[] = [];
    const operation = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise(() => {}); });
    const checked = expect(executor.call({ chatId: "100", operation: "editMessageText", critical: true }, operation))
      .rejects.toMatchObject({ code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(120_000);
    await checked;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(operation.mock.calls.length).toBeLessThanOrEqual(6);
    const count = operation.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(operation).toHaveBeenCalledTimes(count);
  });

  it("respects cancellation during recovery and does not retry after shutdown", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new HttpError("secret", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const checked = expect(executor.call({ chatId: "100", operation: "sendMessage", critical: true }, operation, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await checked;
    await vi.runAllTimersAsync();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps another chat independent while one chat is recovering", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const slow = vi.fn().mockRejectedValueOnce(new HttpError("secret", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).mockResolvedValue("recovered");
    const pending = executor.call({ chatId: "100", operation: "sendMessage", critical: true }, slow);
    await expect(executor.call({ chatId: "200", operation: "sendMessage", critical: true }, async () => "other chat"))
      .resolves.toBe("other chat");
    expect(slow).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("recovered");
  });

  it("honors rate limit recovery but refuses delays outside the total budget", async () => {
    vi.useFakeTimers();
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const limited = (seconds: number) => new GrammyError("fixture", { ok: false, error_code: 429,
      description: "secret", parameters: { retry_after: seconds } }, "sendMessage", {});
    const operation = vi.fn().mockRejectedValueOnce(limited(35)).mockResolvedValue("ok");
    const result = executor.call({ chatId: "100", operation: "sendMessage", critical: true }, operation);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    const error = limited(121);
    const rejected = vi.fn().mockRejectedValue(error);
    await expect(executor.call({ chatId: "100", operation: "sendMessage", critical: true }, rejected)).rejects.toBe(error);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("logs elapsed time, final failure and uncertainty without error text", async () => {
    vi.useFakeTimers();
    const entries: string[] = [];
    const logger = pino({}, { write: value => { entries.push(value); } });
    const executor = new TelegramApiExecutor(logger);
    const error = new HttpError("bot123:secret", Object.assign(new Error("Authorization: secret"), { code: "ECONNRESET" }));
    const operation = vi.fn().mockRejectedValue(error);
    const checked = expect(executor.call({ chatId: "100", operation: "sendMessage", critical: true }, operation)).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await checked;
    expect(operation).toHaveBeenCalledTimes(1);
    expect(JSON.parse(entries.at(-1)!)).toMatchObject({ operation: "sendMessage", attempt: 1,
      networkCode: "ECONNRESET", deliveryUncertain: true, elapsedMs: expect.any(Number),
      msg: "Telegram API 请求失败，已结束本次投递" });
    expect(entries.join("")).not.toContain("secret");
  });

  it("does not retry transient typing failures", async () => {
    const executor = new TelegramApiExecutor(pino({ level: "silent" }));
    const error = new HttpError("network failed", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    const operation = vi.fn().mockRejectedValue(error);

    await expect(executor.call(
      { chatId: "100", operation: "sendChatAction", critical: false },
      operation,
    )).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
