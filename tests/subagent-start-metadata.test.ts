import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionOutputEnricher, type CompletionOutputEnricherOptions } from "../src/bootstrap/completion-output-enricher.js";
import type { OutputEvent } from "../src/conversation-core/index.js";

const baseEvent: Extract<OutputEvent, { type: "subagent.spawned" }> = {
  type: "subagent.spawned",
  target: { surface: "telegram", accountId: "a", conversationId: "c" },
  threadId: "parent", turnId: "turn", agentThreadId: "child", agentPath: "/root/child",
};
const metadata = { id: "child", parentThreadId: "parent", sessionId: "parent", modelProvider: "openai", model: "child-model", reasoningEffort: "high" };
function fixture(read: NonNullable<CompletionOutputEnricherOptions["subagentMetadata"]>) {
  const logger = pino({ enabled: false });
  const warn = vi.spyOn(logger, "warn");
  const enricher = new CompletionOutputEnricher(logger, undefined, { subagentMetadata: read });
  return { enricher, warn };
}

afterEach(() => vi.useRealTimers());

it("reads updated settings for a follow-up instead of reusing the start settings", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce({ ...metadata, modelProvider: "custom-provider", model: "updated-model", reasoningEffort: "medium" });
  const { enricher } = fixture(read);
  await expect(enricher.enrich(baseEvent)).resolves.toMatchObject({ modelProvider: "openai", model: "child-model", reasoningEffort: "high" });
  await expect(enricher.enrich({ ...baseEvent, type: "subagent.contacted" })).resolves.toMatchObject({ modelProvider: "custom-provider", model: "updated-model", reasoningEffort: "medium" });
  expect(read).toHaveBeenCalledTimes(2);
  enricher.stop();
});

describe.each(["subagent.spawned", "subagent.contacted"] as const)("%s metadata enrichment", (type) => {
  const event = { ...baseEvent, type };
  it("uses the exact child Thread configuration without changing activity identity", async () => {
    const read = vi.fn(async () => metadata);
    const { enricher } = fixture(read);
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: "openai", model: "child-model", reasoningEffort: "high" });
    expect(read).toHaveBeenCalledWith("child", expect.any(AbortSignal));
    enricher.stop();
  });

  it.each([
    { ...metadata, id: "another-child" },
    { ...metadata, parentThreadId: "another-parent" },
    { ...metadata, parentThreadId: null },
    { ...metadata, parentThreadId: " " },
  ])("rejects unrelated official Thread metadata %j", async (result) => {
    const { enricher, warn } = fixture(async () => result);
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(warn).toHaveBeenCalledOnce();
    enricher.stop();
  });

  it("preserves unavailable settings as unknown", async () => {
    const { enricher } = fixture(async () => ({ ...metadata, modelProvider: null, model: null, reasoningEffort: null }));
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    enricher.stop();
  });

  it("bounds a stuck read to two seconds and aborts its RPC signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { enricher, warn } = fixture((_id, abort) => { signal = abort; return new Promise(() => undefined); });
    const pending = enricher.enrich(event);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    enricher.stop();
  });

  it("recovers a failed read without exposing the exception", async () => {
    const { enricher, warn } = fixture(async () => { throw new Error("sensitive upstream detail"); });
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(warn).toHaveBeenCalledWith({ agentThreadId: "child" }, "子代理配置读取失败，省略模型设置");
    enricher.stop();
  });

  it("stops in-flight reads promptly even when a reader ignores cancellation", async () => {
    vi.useFakeTimers();
    let resolve!: (value: typeof metadata) => void;
    let signal: AbortSignal | undefined;
    const { enricher } = fixture((_id, abort) => {
      signal = abort;
      return new Promise((accept) => { resolve = accept; });
    });
    const pending = enricher.enrich(event);
    enricher.stop();
    await expect(pending).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    resolve(metadata);
  });

  it("does not start new reads after shutdown begins", async () => {
    const read = vi.fn(async () => metadata);
    const { enricher } = fixture(read);
    enricher.beginShutdown();
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(read).not.toHaveBeenCalled();
    enricher.stop();
  });
});

describe("contacted agents in the same official session tree", () => {
  const event = { ...baseEvent, type: "subagent.contacted" as const };

  it.each([
    { threadId: "parent", parentThreadId: "middle", agentPath: "/root/middle/child" },
    { threadId: "sibling", parentThreadId: "parent", agentPath: "/root/child" },
  ])("accepts a grandchild or sibling after checking the initiating Thread %j", async (relation) => {
    const contacted = { ...event, threadId: relation.threadId, agentPath: relation.agentPath };
    const read = vi.fn()
      .mockResolvedValueOnce({ ...metadata, parentThreadId: relation.parentThreadId })
      .mockResolvedValueOnce({ id: relation.threadId, sessionId: metadata.sessionId });
    const { enricher, warn } = fixture(read);
    await expect(enricher.enrich(contacted)).resolves.toEqual({ ...contacted, modelProvider: "openai", model: "child-model", reasoningEffort: "high" });
    expect(read).toHaveBeenNthCalledWith(1, "child", expect.any(AbortSignal));
    expect(read).toHaveBeenNthCalledWith(2, relation.threadId, read.mock.calls[0]?.[1]);
    expect(warn).not.toHaveBeenCalled();
    enricher.stop();
  });

  it.each([
    { id: "parent", sessionId: "another-session" },
    { id: "wrong-sender", sessionId: "parent" },
    { id: "parent", sessionId: null },
    { id: "parent", sessionId: " " },
  ])("rejects an unrelated or unverified initiating Thread %j", async (sender) => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ...metadata, parentThreadId: "middle" })
      .mockResolvedValueOnce(sender);
    const { enricher, warn } = fixture(read);
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(read).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    enricher.stop();
  });

  it.each([null, "", " "])("rejects a target without a nonempty session ID (%j) before reading the sender", async (sessionId) => {
    const read = vi.fn(async () => ({ ...metadata, parentThreadId: "middle", sessionId }));
    const { enricher } = fixture(read);
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(read).toHaveBeenCalledOnce();
    enricher.stop();
  });

  it("keeps the direct parent check for spawned agents even in the same session", async () => {
    const read = vi.fn(async () => ({ ...metadata, parentThreadId: "middle" }));
    const { enricher } = fixture(read);
    await expect(enricher.enrich(baseEvent)).resolves.toEqual({ ...baseEvent, modelProvider: null, model: null, reasoningEffort: null });
    expect(read).toHaveBeenCalledOnce();
    enricher.stop();
  });

  it("shares the two-second budget and cancellation signal with a stuck sender read", async () => {
    vi.useFakeTimers();
    let resolveTarget!: (value: typeof metadata) => void;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveTarget = resolve; }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const { enricher, warn } = fixture(read);
    const pending = enricher.enrich(event);
    await vi.advanceTimersByTimeAsync(1_500);
    resolveTarget({ ...metadata, parentThreadId: "middle" });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    const signal = read.mock.calls[0]?.[1] as AbortSignal;
    expect(read.mock.calls[1]?.[1]).toBe(signal);
    await vi.advanceTimersByTimeAsync(499);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(signal.aborted).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    enricher.stop();
  });

  it("recovers a failed sender read without exposing the exception", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ...metadata, parentThreadId: "middle" })
      .mockRejectedValueOnce(new Error("sensitive upstream detail"));
    const { enricher, warn } = fixture(read);
    await expect(enricher.enrich(event)).resolves.toEqual({ ...event, modelProvider: null, model: null, reasoningEffort: null });
    expect(warn).toHaveBeenCalledWith({ agentThreadId: "child" }, "子代理配置读取失败，省略模型设置");
    enricher.stop();
  });
});
