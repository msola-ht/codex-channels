import pino from "pino";
import { describe, expect, it } from "vitest";

import { withDeliveryRetry } from "../src/surfaces/delivery-retry.js";

const logger = pino({ level: "silent" });

describe("withDeliveryRetry", () => {
  it("retries a failure the policy marks as retriable", async () => {
    let attempts = 0;
    const result = await withDeliveryRetry(
      {
        component: "Test",
        maximumAttempts: 3,
        maximumDelayMs: 10,
        delayMs: () => 0,
        logger,
      },
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("可重试失败");
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops at the maximum attempt count", async () => {
    let attempts = 0;
    await expect(
      withDeliveryRetry(
        {
          component: "Test",
          maximumAttempts: 2,
          maximumDelayMs: 10,
          delayMs: () => 0,
          logger,
        },
        async () => {
          attempts += 1;
          throw new Error("可重试失败");
        },
      ),
    ).rejects.toThrow("可重试失败");

    expect(attempts).toBe(2);
  });

  it("never waits longer than the configured cap", async () => {
    let attempts = 0;
    await expect(
      withDeliveryRetry(
        {
          component: "Test",
          maximumAttempts: 3,
          maximumDelayMs: 10,
          delayMs: () => 60_000,
          logger,
        },
        async () => {
          attempts += 1;
          throw new Error("等待过久");
        },
      ),
    ).rejects.toThrow("等待过久");

    expect(attempts).toBe(1);
  });

  it("cancels a pending retry wait", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = withDeliveryRetry(
      {
        component: "Test",
        maximumAttempts: 3,
        maximumDelayMs: 5_000,
        delayMs: () => 1_000,
        logger,
      },
      async () => {
        attempts += 1;
        throw new Error("可重试失败");
      },
      controller.signal,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toThrow("渠道发送重试已取消");
    expect(attempts).toBe(1);
  });

  it("keeps the failed send as the cause when a retry wait is cancelled", async () => {
    const controller = new AbortController();
    const failure = new Error("平台拒绝");
    const pending = withDeliveryRetry(
      {
        component: "Test",
        maximumAttempts: 3,
        maximumDelayMs: 5_000,
        delayMs: () => 1_000,
        logger,
      },
      async () => {
        throw failure;
      },
      controller.signal,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    // 取消不能掩盖真正失败的发送错误，否则日志里只剩一次无原因的取消。
    await expect(pending).rejects.toMatchObject({ cause: failure });
  });
});

it("does not start an already cancelled send", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  const result = withDeliveryRetry({ component: "Test", maximumAttempts: 3, maximumDelayMs: 10,
    delayMs: () => 0, logger }, async () => { attempts++; }, controller.signal);
  await expect(result.then(() => "sent", () => "cancelled")).resolves.toBe("cancelled");
  expect(attempts).toBe(0);
});
