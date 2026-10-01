import { UserFacingError } from "../src/conversation-core/index.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/index.js";
import { ConversationDeliveryQueue } from "../src/surfaces/conversation-delivery-queue.js";
import { observeSurfaceStage, surfaceDiagnosticContext, withSurfaceDiagnosticContext,
  withSurfaceOutputDiagnostics } from "../src/surfaces/diagnostics.js";

function capture(level = "debug") {
  const records: Array<Record<string, unknown>> = [];
  const logger = pino({ level }, { write(line) { records.push(JSON.parse(line)); } });
  return { logger, records };
}

function answer(surface: "telegram" | "feishu" | "weixin"): OutputEvent {
  return { type: "text.completed", target: { surface, accountId: "account", conversationId: "chat" },
    threadId: `thread-${surface}`, turnId: "turn", itemId: "item", phase: "final_answer",
    text: "PRIVATE MESSAGE BODY" };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("Surface diagnostics", () => {
  it("classifies request cancellation independently of the conversation worker", async () => {
    const { logger, records } = capture();
    const queue = new ConversationDeliveryQueue(logger, { component: "Telegram" });
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const cancelled = queue.runOrdered("chat", (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      started();
    }), controller.signal);
    const rejection = expect(cancelled).rejects.toThrow("cancelled");
    await ready;
    controller.abort();
    await rejection;
    await queue.runOrdered("chat", async () => undefined);
    await queue.close();
    const outcomes = records.filter((record) => record.stage === "delivery" && record.outcome);
    expect(outcomes.map((record) => record.outcome)).toEqual(["cancelled", "completed"]);
  });

  it.each(["telegram", "feishu", "weixin"] as const)("keeps %s final delivery evidence at info without bodies", async (surface) => {
    const { logger, records } = capture("info");
    const queue = new ConversationDeliveryQueue(logger, { component: surface });
    withSurfaceOutputDiagnostics(logger, answer(surface), () => queue.enqueue("chat", async () => undefined, true));
    await queue.close();
    const record = records.find((r) => r.msg === "Surface 输出任务处理完成");
    expect(record).toMatchObject({ component: surface, accountId: "account", conversationId: "chat",
      eventType: "text.completed", threadId: `thread-${surface}`, turnId: "turn", itemId: "item", purpose: "output", outcome: "completed",
      deliveryId: expect.any(String), queueWaitMs: expect.any(Number), executionMs: expect.any(Number) });
    expect(JSON.stringify(records)).not.toContain("PRIVATE MESSAGE BODY");
  });

  it("isolates simultaneous channels and distinguishes waiting from execution with nested API correlation", async () => {
    vi.useFakeTimers();
    const { logger, records } = capture();
    const telegram = new ConversationDeliveryQueue(logger, { component: "Telegram" });
    const feishu = new ConversationDeliveryQueue(logger, { component: "Feishu" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    telegram.enqueue("chat", () => gate, false);
    await settle();
    withSurfaceOutputDiagnostics(logger, answer("telegram"), () => telegram.enqueue("chat", () =>
      observeSurfaceStage(logger, { stage: "api", operation: "editMessageText" }, async () => undefined), true));
    withSurfaceOutputDiagnostics(logger, answer("feishu"), () => feishu.enqueue("chat", async () => undefined, true));
    await settle();
    expect(records.some((r) => r.msg === "Surface 输出任务处理完成" && r.component === "Feishu")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(records.filter((r) => r.msg === "Surface 阶段仍未完成")).toHaveLength(1);
    release();
    await settle();
    const slow = records.find((r) => r.eventType === "text.completed" && r.stage === "delivery" && r.outcome === "completed" && r.component === "Telegram");
    expect(slow).toMatchObject({ queueWaitMs: 10_000, executionMs: 0, totalMs: 10_000, threadId: "thread-telegram" });
    const api = records.find((r) => r.stage === "api" && r.outcome === "completed");
    expect(api?.deliveryId).toBe(slow?.deliveryId);
    expect(api?.threadId).toBe("thread-telegram");
    await Promise.all([telegram.close(), feishu.close()]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(records.filter((r) => r.msg === "Surface 阶段仍未完成")).toHaveLength(1);
    expect(surfaceDiagnosticContext()).toEqual({});
  });

  it("records ordered failures without treating a rejected interaction as successful delivery", async () => {
    const { logger, records } = capture();
    const queue = new ConversationDeliveryQueue(logger, { component: "Feishu" });
    const error = Object.assign(new Error("SECRET URL TOKEN"), { code: "ECONNRESET" });
    await expect(queue.runOrdered("chat", async () => { throw error; })).rejects.toBe(error);
    await queue.close();
    expect(records.find((r) => r.outcome === "failed")).toMatchObject({
      stage: "delivery", errorCode: "ECONNRESET", critical: true, deliveryId: expect.any(String),
    });
    expect(records.some((r) => r.outcome === "completed")).toBe(false);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it("identifies coalesced and capacity-displaced output while retaining critical messages", async () => {
    const { logger, records } = capture();
    const queue = new ConversationDeliveryQueue(logger, { component: "Weixin", capacity: 1 });
    let release!: () => void;
    queue.enqueue("chat", () => new Promise<void>((resolve) => { release = resolve; }), true);
    await settle();
    const discarded = vi.fn(async () => undefined);
    queue.enqueue("chat", discarded, false, { coalesceKey: "status" });
    queue.enqueue("chat", discarded, false, { coalesceKey: "status" });
    const critical = vi.fn(async () => undefined);
    queue.enqueue("chat", critical, true);
    release();
    await queue.close();
    expect(discarded).not.toHaveBeenCalled();
    expect(critical).toHaveBeenCalledOnce();
    expect(records.filter((r) => r.reason === "coalesced")).toHaveLength(1);
    expect(records.filter((r) => r.reason === "capacity")).toHaveLength(1);
  });

  it("bounds and sanitizes nested error causes and cancels the slow alarm", async () => {
    vi.useFakeTimers();
    const { logger, records } = capture();
    const cause = Object.assign(new Error("SECRET RESPONSE"), { code: "ETIMEDOUT" });
    const error = new Error("SECRET REQUEST", { cause });
    cause.cause = error;
    await expect(withSurfaceDiagnosticContext({ component: "Weixin", inputId: "input" }, () =>
      observeSurfaceStage(logger, { stage: "input" }, async () => { throw error; }))).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(records.find((r) => r.outcome === "failed")).toMatchObject({ inputId: "input",
      causes: [{ errorType: "Error", errorCode: "ETIMEDOUT" }] });
    expect(records.some((r) => r.msg === "Surface 阶段仍未完成")).toBe(false);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
});


it("correlates image failure diagnostics with the input without logging the message", async () => {
  const { logger, records } = capture();
  const error = new UserFacingError("image.reference.failed", "PRIVATE MESSAGE BODY", {
    stage: "file-transfer", reason: "network-timeout", networkCode: "UND_ERR_CONNECT_TIMEOUT",
    diagnosticId: "123e4567-e89b-42d3-a456-426614174000", elapsedMs: "10001",
  });
  await expect(withSurfaceDiagnosticContext({ inputId: "input-1" }, () =>
    observeSurfaceStage(logger, { stage: "input" }, async () => { throw error; }))).rejects.toBe(error);
  const failed = records.find(record => record.outcome === "failed");
  expect(failed).toMatchObject({ inputId: "input-1", stage: "input", imageUploadStage: "file-transfer",
    imageUploadNetworkCode: "UND_ERR_CONNECT_TIMEOUT", imageUploadDiagnosticId: error.details.diagnosticId });
  expect(JSON.stringify(records)).not.toContain("PRIVATE MESSAGE BODY");
});
