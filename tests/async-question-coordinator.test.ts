import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { EventBus } from "../src/event-bus/index.js";
import { AsyncQuestionCoordinator } from "../src/bootstrap/async-question-coordinator.js";
import type { InteractionDecision, InteractionRequest } from "../src/approval/index.js";
import type { ConversationInputEvent, OutputEvent } from "../src/conversation-core/index.js";

const target = { surface: "telegram", accountId: "default", conversationId: "100" };
const event: Extract<ConversationInputEvent, { type: "item.agentMessage.completed" }> = {
  type: "item.agentMessage.completed", delivery: "async", phase: "final_answer", text: "Choose",
  threadId: "thread-1", turnId: "turn-1", itemId: "question-1", questions: [{ title: "Choose", options: ["A", "B"] }],
};

function fixture() {
  let threadId = "thread-1";
  let answer!: (decision: InteractionDecision) => void;
  const request = vi.fn((_target: unknown, _request: InteractionRequest) => {
    void _target;
    void _request;
    return new Promise<InteractionDecision>((resolve) => { answer = resolve; });
  });
  const resolved = vi.fn();
  const submit = vi.fn(async () => undefined);
  const warn = vi.fn();
  const coordinator = new AsyncQuestionCoordinator({
    interactions: { request, resolved }, timeoutMs: 1_000,
    currentThread: () => threadId, targetForThread: () => target, submit, warn,
  });
  return { coordinator, request, resolved, submit, warn,
    answer: (decision: InteractionDecision) => answer(decision),
    switchThread: () => { threadId = "thread-2"; coordinator.cancelStale(); },
  };
}

afterEach(() => vi.useRealTimers());

describe("AsyncQuestionCoordinator", () => {
  it.each<ConversationInputEvent>([
    { type: "thread.reverted", threadId: "thread-1" },
    { type: "thread.closed", threadId: "thread-1" },
    { type: "thread.archived", threadId: "thread-1" },
    { type: "thread.deleted", threadId: "thread-1" },
    { type: "turn.completed", threadId: "thread-1", turnId: "turn-1", status: "failed", error: "failed" },
    { type: "turn.completed", threadId: "thread-1", turnId: "turn-1", status: "interrupted", error: null },
  ])("keeps question registration and $type ordered while output is blocked", async (invalidation) => {
    const f = fixture();
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const inbound = new EventBus<ConversationInputEvent>(pino({ level: "silent" }));
    let releaseOutput!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseOutput = resolve; });
    const delivered = vi.fn();
    output.subscribe("slow-output", async () => { await blocked; delivered(); });
    inbound.subscribe("questions", (input) => f.coordinator.handleInput(input));
    try {
      output.publish({ type: "warning", target, message: "backlog" });
      inbound.publish(event, true);
      inbound.publish(invalidation, true);
      await vi.waitFor(() => expect(f.resolved).toHaveBeenCalledTimes(1));
      expect(delivered).not.toHaveBeenCalled();
      expect(f.request).toHaveBeenCalledTimes(1);
      f.answer({ type: "user-input", answers: { q1: ["late"] } });
      releaseOutput();
      await output.close();
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.request).toHaveBeenCalledTimes(1);
      inbound.publish({ ...event, turnId: "turn-2", itemId: "question-2" }, true);
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    } finally {
      releaseOutput();
      await inbound.close();
      await output.close();
      await f.coordinator.close();
    }
  });

  it.each(["disconnect", "timeout", "switch", "close"])("reports an unconfirmed submission after %s without retrying", async (reason) => {
    vi.useFakeTimers();
    const f = fixture();
    let rejectSubmit!: (error: Error) => void;
    f.submit.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { rejectSubmit = reject; }));
    f.coordinator.handleInput(event);
    f.answer({ type: "user-input", answers: { q1: ["A"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.submit).toHaveBeenCalledTimes(1);
    let closing: Promise<void> | undefined;
    if (reason === "disconnect") f.coordinator.cancelThread(event.threadId);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1_000);
    if (reason === "switch") f.switchThread();
    if (reason === "close") closing = f.coordinator.close();
    rejectSubmit(new Error("submission result unknown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ threadId: event.threadId }), expect.stringContaining("未确认送达"));
    expect(f.submit).toHaveBeenCalledTimes(1);
    await closing;
    await f.coordinator.close();
  });

  it("does not report a failed submission when a write succeeds after cancellation", async () => {
    const f = fixture();
    let complete!: () => void;
    f.submit.mockImplementationOnce(() => new Promise<undefined>((resolve) => { complete = () => resolve(undefined); }));
    f.coordinator.handleInput(event);
    f.answer({ type: "user-input", answers: { q1: ["A"] } });
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    f.coordinator.cancelThread(event.threadId);
    complete();
    await f.coordinator.close();
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("submits ordinary input once, preserving the question and free-text answer", async () => {
    const f = fixture();
    f.coordinator.handleInput(event);
    f.coordinator.handleInput(event);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({ asynchronous: true, questions: [{ options: ["A", "B"], allowOther: true }] });
    f.answer({ type: "user-input", answers: { q1: ["custom"] } });
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    expect(f.submit).toHaveBeenCalledWith(target, event.threadId, "异步问题回答：\n\nChoose\n回答：custom", expect.any(Function));
    f.coordinator.handleInput(event);
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.coordinator.close();
  });

  it.each(["switch", "timeout", "revert", "close"])("invalidates late answers after %s", async (reason) => {
    vi.useFakeTimers();
    const f = fixture();
    f.coordinator.handleInput(event);
    if (reason === "switch") f.switchThread();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1_000);
    if (reason === "revert") f.coordinator.cancelThread(event.threadId);
    if (reason === "close") await f.coordinator.close();
    f.answer({ type: "user-input", answers: { q1: ["A"] } });
    await Promise.resolve();
    expect(f.resolved).toHaveBeenCalledTimes(1);
    expect(f.submit).not.toHaveBeenCalled();
    await f.coordinator.close();
  });

  it("keeps questions answerable after the originating Turn completes and batches long forms", async () => {
    const f = fixture();
    f.coordinator.handleInput({ ...event, questions: Array.from({ length: 4 }, (_, index) => ({ title: `Q${index + 1}`, options: [] })) });
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({ questions: [{ id: "q1" }, { id: "q2" }, { id: "q3" }] });
    f.coordinator.handleInput({
      type: "turn.completed", threadId: event.threadId, turnId: event.turnId,
      status: "completed", error: null,
    });
    expect(f.resolved).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    f.answer({ type: "user-input", answers: { q1: ["a"], q2: ["b"], q3: ["c"] } });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.request.mock.calls[1]?.[1]).toMatchObject({ questions: [{ id: "q4" }] });
    f.answer({ type: "user-input", answers: { q4: ["d"] } });
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2));
    expect(f.submit).toHaveBeenNthCalledWith(
      1, target, event.threadId, "异步问题回答：\n\nQ1\n回答：a\n\nQ2\n回答：b\n\nQ3\n回答：c", expect.any(Function),
    );
    expect(f.submit).toHaveBeenNthCalledWith(
      2, target, event.threadId, "异步问题回答：\n\nQ4\n回答：d", expect.any(Function),
    );
    expect(f.resolved).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
    await f.coordinator.close();
  });

  it("does not submit cancelled forms or retry uncertain writes", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new Error("transport failed"));
    f.coordinator.handleInput(event);
    f.answer({ type: "user-input", answers: { q1: ["A"] } });
    await vi.waitFor(() => expect(f.warn).toHaveBeenCalledTimes(1));
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.coordinator.handleInput({ ...event, itemId: "question-2" });
    f.answer({ type: "user-input", answers: {} });
    await f.coordinator.close();
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
});
