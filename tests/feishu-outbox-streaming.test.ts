import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutputEvent } from "../src/conversation-core/index.js";
import type { ConversationDeliveryQueue } from "../src/surfaces/conversation-delivery-queue.js";
import { FeishuTextStreams } from "../src/surfaces/feishu/text-streams.js";
import {
  FeishuMessageError,
  FeishuOutbox,
} from "../src/surfaces/feishu/index.js";
import { completed, delta, operationUpdated, target, threadStatus, turnCompleted } from "./support/feishu-outbox-fixtures.js";


const turnCompletedMarkdown = "## 本次运行 · 已完成\n\n- 本轮耗时：未提供\n- 响应：—\n- 速度：—\n\n### 当前会话\n- Session：测试会话\n- Session ID：thread-1\n- 总耗时：未提供";

const cardMethods = {
  sendCard: async () => "om_card",
  sendMarkdownCard: async () => {},
  updateCard: async () => {},
  createStreamingCard: async () => ({
    cardId: "7355372766134157313",
    messageId: "om_stream",
  }),
  updateStreamingCard: async () => {},
  finishStreamingCard: async () => {},
};

afterEach(() => {
  vi.useRealTimers();
});


describe("Feishu outbox streaming lifecycle", () => {
  it("waits for every completion operation when a rejected enqueue already settled", () => {
    vi.useFakeTimers();
    let acceptedSettlement: (() => void) | undefined;
    const enqueue = vi.fn<ConversationDeliveryQueue["enqueue"]>((_chat, _run, _critical, options) => {
      if (enqueue.mock.calls.length === 1) {
        options?.settled?.();
        return false;
      }
      acceptedSettlement = options?.settled;
      return true;
    });
    const streams = new FeishuTextStreams({ ...cardMethods, sendText: async () => {}, sendPost: async () => {} },
      { enqueue }, { get: () => undefined }, pino({ level: "silent" }), () => false,
      async () => {}, async () => 0);
    streams.acceptStreamDelta(delta("first", "first-item") as Extract<OutputEvent, { type: "text.delta" }>);
    streams.acceptStreamDelta(delta("second", "second-item") as Extract<OutputEvent, { type: "text.delta" }>);
    const settled = vi.fn();

    expect(streams.finishStreamsForTurn(target.conversationId, "thread-1", "turn-1", "footer", settled)).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    expect(acceptedSettlement).toBeDefined();
    acceptedSettlement!();
    acceptedSettlement!();
    expect(settled).toHaveBeenCalledOnce();
    streams.clear();
  });

  it("delivers completion independently after a durable final rollover fails", async () => {
    vi.useFakeTimers();
    const footers: string[] = [];
    const finish = vi.fn(async () => {
      throw new FeishuMessageError("send-timeout", "fixture");
    });
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      sendMarkdownCard: async (_id, body) => { footers.push(body); },
      finishStreamingCard: finish,
    }, pino({ level: "silent" }));
    try {
      outbox.handle(delta("partial"));
      await vi.advanceTimersByTimeAsync(300);
      await expect(outbox.deliver(completed({}, "partial" + "x".repeat(5_001), "item-1"),
        new AbortController().signal, async () => {})).rejects.toThrow();

      await outbox.deliver(turnCompleted(), new AbortController().signal, async () => {});

      expect(finish).toHaveBeenCalledOnce();
      expect(footers).toEqual([turnCompletedMarkdown]);
    } finally {
      await outbox.close();
    }
  });

  it.each(["active", "finished"] as const)("releases reply targets after %s stream completion", async (state) => {
    vi.useFakeTimers();
    const sent = vi.fn(async () => "sent-message");
    const replied = vi.fn(async () => "reply-message");
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      sendMarkdownCard: sent,
      replyMarkdownCard: replied,
    }, pino({ level: "silent" }));
    try {
      outbox.prepareTurnReplyTarget(target.conversationId, "input-message");
      outbox.handle({ type: "turn.started", target, threadId: "thread-1", turnId: "turn-1" });
      outbox.handle(delta("partial"));
      await vi.advanceTimersByTimeAsync(300);
      expect(replied).toHaveBeenCalledWith("input-message", expect.any(String), expect.any(AbortSignal));
      outbox.handle(completed({}, "partial FINAL", "item-1"));
      if (state === "finished") await vi.advanceTimersByTimeAsync(0);
      outbox.handle(turnCompleted());
      await vi.advanceTimersByTimeAsync(0);
      sent.mockClear();
      replied.mockClear();

      // An explicitly replayed result for a settled Turn has no live input reply target.
      await outbox.deliver(completed({}, "replayed result", "replayed-item"),
        new AbortController().signal, async () => {});

      expect(replied).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledWith(target.conversationId, "replayed result", expect.any(AbortSignal));
    } finally {
      await outbox.close();
    }
  });

  it("does not replay a durable final body cancelled while queued when delivering completion", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const finish = vi.fn(async () => {});
    const footers: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      updateStreamingCard: async () => { await blocked; },
      finishStreamingCard: finish,
      sendMarkdownCard: async (_id, body) => { footers.push(body); },
    }, pino({ level: "silent" }));
    try {
      outbox.handle(delta("partial"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta(" updated"));
      await vi.advanceTimersByTimeAsync(300);
      const controller = new AbortController();
      const body = outbox.deliver(completed({}, "partial updated FINAL", "item-1"),
        controller.signal, async () => {});
      const rejected = expect(body).rejects.toThrow();
      controller.abort();
      await rejected;
      release();
      await vi.advanceTimersByTimeAsync(0);

      await outbox.deliver(turnCompleted(), new AbortController().signal, async () => {});

      expect(finish).not.toHaveBeenCalled();
      expect(footers).toEqual([turnCompletedMarkdown]);
    } finally {
      release();
      await outbox.close();
    }
  });

  it.each(["failed", "cancelled"] as const)("releases reply targets after a %s streaming footer", async (outcome) => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sent = vi.fn(async () => "sent-message");
    const replied = vi.fn(async () => "reply-message");
    const footerStarted = vi.fn();
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      sendMarkdownCard: sent,
      replyMarkdownCard: replied,
      finishStreamingCard: async (_id, _sequence, _body, footer) => {
        if (footer === undefined) return;
        footerStarted();
        if (outcome === "failed") throw new FeishuMessageError("send-timeout", "fixture");
        await blocked;
      },
    }, pino({ level: "silent" }));
    try {
      outbox.prepareTurnReplyTarget(target.conversationId, "input-message");
      outbox.handle({ type: "turn.started", target, threadId: "thread-1", turnId: "turn-1" });
      outbox.handle(delta("partial"));
      await vi.advanceTimersByTimeAsync(300);
      await outbox.deliver(completed({}, "partial FINAL", "item-1"),
        new AbortController().signal, async () => {});
      const controller = new AbortController();
      const completion = outbox.deliver(turnCompleted(), controller.signal, async () => {});
      const rejected = expect(completion).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(footerStarted).toHaveBeenCalledOnce();
      if (outcome === "cancelled") controller.abort();
      await rejected;
      release();
      await vi.advanceTimersByTimeAsync(0);
      sent.mockClear();
      replied.mockClear();

      await outbox.deliver(completed({}, "replayed result", "replayed-item"),
        new AbortController().signal, async () => {});

      expect(replied).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledWith(target.conversationId, "replayed result", expect.any(AbortSignal));
    } finally {
      release();
      await outbox.close();
    }
  });

  it("keeps deltas received while a content update is pending", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const updated: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      updateStreamingCard: async (_id, text) => {
        updated.push(text);
        if (updated.length === 1) await blocked;
      },
    }, pino({ level: "silent" }));
    outbox.handle(delta("A"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(delta("B"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(delta("C"));
    await vi.advanceTimersByTimeAsync(300);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(updated).toEqual(["AB", "ABC"]);
    await outbox.close();
  });

  it.each(["text", "turn"] as const)("supersedes a queued refresh with %s completion while preserving the in-flight update and receipt", async (completion) => {
    vi.useFakeTimers();
    let releaseUpdate!: () => void;
    let releaseFinish!: () => void;
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const finishBlocked = new Promise<void>((resolve) => { releaseFinish = resolve; });
    const calls: string[] = [];
    let updateSignal: AbortSignal | undefined;
    const checkpoints: string[] = [];
    const delivered = vi.fn();
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      updateStreamingCard: async (_id, text, sequence, signal) => {
        calls.push(`update:${text}:${sequence}`);
        updateSignal = signal;
        await updateBlocked;
      },
      finishStreamingCard: async (_id, sequence, text) => {
        calls.push(`finish:${text}:${sequence}`);
        await finishBlocked;
      },
    }, pino({ level: "silent" }));
    try {
      outbox.handle(delta("A"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta("B"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta("C"));
      await vi.advanceTimersByTimeAsync(300);
      const finalText = completion === "text" ? "ABC-final" : "ABC";
      const delivery = outbox.deliver(completion === "text" ? completed({}, finalText, "item-1") : turnCompleted(),
        new AbortController().signal, async ({ state }) => { checkpoints.push(state); }).then(delivered);

      expect(calls).toEqual(["update:AB:1"]);
      expect(updateSignal?.aborted).toBe(false);
      releaseUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["update:AB:1", `finish:${finalText}:2`]);
      expect(delivered).not.toHaveBeenCalled();
      expect(checkpoints).not.toContain("confirmed");
      releaseFinish();
      await delivery;
      expect(delivered).toHaveBeenCalledOnce();
      expect(checkpoints).toContain("confirmed");
    } finally {
      releaseUpdate();
      releaseFinish();
      await outbox.close();
    }
  });

  it.each(["item", "chat"] as const)("invalidates queued refreshes only for the completed stream across a different %s", async (isolation) => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const otherTarget = isolation === "chat" ? { ...target, conversationId: "oc_other" } : target;
    const otherDelta = (text: string): OutputEvent => ({ ...delta(text, "item-2"), target: otherTarget });
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      createStreamingCard: async (chatId, text) => ({ cardId: `${chatId}:${text}`, messageId: "message" }),
      updateStreamingCard: async (id, text, sequence) => {
        calls.push(`update:${id}:${text}:${sequence}`);
        if (sequence === 1) await blocked;
      },
      finishStreamingCard: async (id, sequence, text) => { calls.push(`finish:${id}:${text}:${sequence}`); },
    }, pino({ level: "silent" }));
    try {
      outbox.handle(delta("A"));
      outbox.handle(otherDelta("X"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta("B"));
      outbox.handle(otherDelta("Y"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta("C"));
      outbox.handle(otherDelta("Z"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(completed({}, "ABC-final", "item-1"));
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.filter((call) => call.includes(`${target.conversationId}:A:`))).toEqual([
        `update:${target.conversationId}:A:AB:1`, `finish:${target.conversationId}:A:ABC-final:2`,
      ]);
      expect(calls.filter((call) => call.includes(`${otherTarget.conversationId}:X:`))).toEqual(isolation === "chat" ? [
        `update:${otherTarget.conversationId}:X:XY:1`, `update:${otherTarget.conversationId}:X:XYZ:2`,
      ] : [`update:${otherTarget.conversationId}:X:XYZ:1`]);
    } finally {
      release();
      await outbox.close();
    }
  });

  it("does not let a queued refresh update a replacement stream with the same identity", async () => {
    vi.useFakeTimers();
    const pending: Array<(signal: AbortSignal) => Promise<void>> = [];
    const create = vi.fn(cardMethods.createStreamingCard);
    const streams = new FeishuTextStreams({ ...cardMethods, createStreamingCard: create,
      sendText: async () => {}, sendPost: async () => {} },
    { enqueue: (_chat, run) => { pending.push(run); return true; } },
    { get: () => undefined }, pino({ level: "silent" }), () => false, async () => {}, async () => 0);
    try {
      streams.acceptStreamDelta(delta("old") as Extract<OutputEvent, { type: "text.delta" }>);
      await vi.advanceTimersByTimeAsync(300);
      streams.clearThread("thread-1");
      streams.acceptStreamDelta(delta("replacement") as Extract<OutputEvent, { type: "text.delta" }>);
      await vi.advanceTimersByTimeAsync(300);

      await pending[0]!(new AbortController().signal);
      expect(create).not.toHaveBeenCalled();
      await pending[1]!(new AbortController().signal);
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(target.conversationId, "replacement", expect.any(AbortSignal));
    } finally {
      streams.clear();
    }
  });

  it("preserves the queued refresh barrier before visible output when completion follows", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      sendMarkdownCard: async () => { calls.push("operation"); },
      updateStreamingCard: async (_id, text, sequence) => {
        calls.push(`update:${text}:${sequence}`);
        if (sequence === 1) await blocked;
      },
      finishStreamingCard: async (_id, sequence, text) => { calls.push(`finish:${text}:${sequence}`); },
    }, pino({ level: "silent" }));
    try {
      outbox.handle(delta("A"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta("B"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(delta("C"));
      await vi.advanceTimersByTimeAsync(300);
      outbox.handle(operationUpdated("completed"));
      outbox.handle(completed({}, "ABC-final", "item-1"));
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["update:AB:1", "update:ABC-final:2", "operation", "finish:ABC-final:3"]);
    } finally {
      release();
      await outbox.close();
    }
  });

  it("preserves deltas received while a full card rolls over", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const finished: string[] = [];
    const updated = vi.fn(async () => {});
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      updateStreamingCard: updated,
      finishStreamingCard: async (_id, _sequence, text) => {
        finished.push(text);
        if (finished.length === 1) await blocked;
      },
    }, pino({ level: "silent" }));
    const prefix = "x".repeat(5001);
    outbox.handle(delta(prefix));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(delta("TAIL"));
    outbox.handle(completed({}, `${prefix}TAIL`, "item-1"));
    release();
    await outbox.close();
    expect(finished.join("")).toBe(`${prefix}TAIL`);
    expect(updated).not.toHaveBeenCalled();
  });

  it("splits content that crosses the element limit during card creation", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const finished: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      createStreamingCard: async (_id, text) => {
        sent.push(text);
        if (sent.length === 1) await blocked;
        return { cardId: "card", messageId: "message" };
      },
      updateStreamingCard: async (_id, text) => { sent.push(text); },
      finishStreamingCard: async (_id, _sequence, text) => { sent.push(text); finished.push(text); },
    }, pino({ level: "silent" }));
    outbox.handle(delta("A"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(delta("B".repeat(5001)));
    release();
    await vi.advanceTimersByTimeAsync(0);
    outbox.handle(completed({}, `A${"B".repeat(5001)}`, "item-1"));
    await outbox.close();
    expect(sent.every((text) => [...text].length <= 5000)).toBe(true);
    expect(finished.join("")).toBe(`A${"B".repeat(5001)}`);
  });

  it("coalesces pending refreshes behind a slow platform request", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const records: Array<{ msg: string; pending?: number }> = [];
    const diagnosticLogger = pino({ level: "debug" }, { write(line) { records.push(JSON.parse(line)); } });
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      createStreamingCard: async () => { await blocked; return { cardId: "card", messageId: "message" }; },
    }, diagnosticLogger);
    outbox.handle(delta("A"));
    await vi.advanceTimersByTimeAsync(300);
    for (let index = 0; index < 10; index += 1) {
      outbox.handle(delta("B"));
      await vi.advanceTimersByTimeAsync(300);
    }
    const queued = records.filter((record) => record.msg === "Surface 输出入队结果");
    expect(queued.length).toBeGreaterThan(1);
    expect(Math.max(...queued.map((record) => record.pending ?? 0))).toBe(1);
    release();
    await outbox.close();
  });

  it("falls back to corrected final text received during rollover", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const posts: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async (_id, text) => { posts.push(text); },
      finishStreamingCard: async () => { await blocked; },
    }, pino({ level: "silent" }));
    outbox.handle(delta("x".repeat(5001)));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "corrected final body", "item-1"));
    release();
    await outbox.close();
    expect(posts).toEqual(["corrected final body"]);
  });

  it("finishes with the final body without a redundant element update", async () => {
    vi.useFakeTimers();
    const updated = vi.fn(async () => {});
    const finished = vi.fn(async () => {});
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async () => {},
      updateStreamingCard: updated,
      finishStreamingCard: finished,
    }, pino({ level: "silent" }));
    outbox.handle(delta("A"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "ABC", "item-1"));
    await outbox.close();
    expect(updated).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledWith("7355372766134157313", 1, "ABC", undefined, expect.any(AbortSignal));
  });

  it.each(["rate-limited", "send-timeout"] as const)("preserves final text when whole-card finish fails with %s", async (code) => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const finishes: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async (_id, body) => { posts.push(body); },
      finishStreamingCard: async (_id, _sequence, body) => {
        finishes.push(body);
        if (finishes.length === 1) throw new FeishuMessageError(code, "fixture");
      },
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "partial FINAL", "item-1"));
    await outbox.close();
    if (code === "rate-limited") {
      expect(posts).toEqual(["partial FINAL"]);
      expect(finishes).toEqual(["partial FINAL"]);
    } else {
      expect(posts).toEqual([]);
      expect(finishes).toEqual(["partial FINAL", "partial FINAL"]);
    }
  });

  it.each([false, true])("does not replay uncertain whole-card writes as new messages (rollover: %s)", async (rollover) => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const finishes: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async (_id, body) => { posts.push(body); },
      finishStreamingCard: async (_id, _sequence, body) => {
        finishes.push(body);
        throw new FeishuMessageError(finishes.length === 1 ? "send-timeout" : "rate-limited", "fixture");
      },
    }, pino({ level: "silent" }));
    const initial = rollover ? "x".repeat(5001) : "partial";
    outbox.handle(delta(initial));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, `${initial} FINAL`, "item-1"));
    await outbox.close();
    expect(finishes).toHaveLength(2);
    expect(finishes[0]).toBe(finishes[1]);
    expect(posts).toEqual([]);
  });

  it("keeps a confirmed final body when only the late footer update fails", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const posts: string[] = [];
    const footers: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      sendPost: async (_id, body) => { posts.push(body); },
      sendMarkdownCard: async (_id, body) => { footers.push(body); },
      finishStreamingCard: async (_id, _sequence, _body, footer) => {
        if (footer === undefined) await blocked;
        else throw new FeishuMessageError("rate-limited", "fixture");
      },
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "partial FINAL", "item-1"));
    await vi.advanceTimersByTimeAsync(0);
    outbox.handle(turnCompleted());
    release();
    await vi.advanceTimersByTimeAsync(0);
    await outbox.close();
    expect(posts).toEqual([]);
    expect(footers).toEqual([turnCompletedMarkdown]);
  });

  it("does not start recovery requests after close has timed out", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const finish = vi.fn(async () => { await blocked; throw new FeishuMessageError("send-timeout", "fixture"); });
    const post = vi.fn(async () => {});
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {}, sendPost: post, finishStreamingCard: finish,
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "partial FINAL", "item-1"));
    const closed = outbox.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closed;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("still delivers completion statistics when body fallback fails", async () => {
    vi.useFakeTimers();
    const footers: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods,
      sendText: async () => {},
      updateStreamingCard: async () => { throw new FeishuMessageError("send-failed", "fixture"); },
      sendPost: async () => { throw new FeishuMessageError("send-failed", "fixture"); },
      sendMarkdownCard: async (_id, body) => { footers.push(body); },
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(delta(" FINAL"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "partial FINAL", "item-1"));
    outbox.handle(turnCompleted());
    await outbox.close();
    expect(footers).toEqual([turnCompletedMarkdown]);
  });

  it("does not update a card whose creation returns after the close deadline", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const update = vi.fn(async () => {});
    const finish = vi.fn(async () => {});
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {}, sendPost: async () => {},
      createStreamingCard: async () => { await blocked; return { cardId: "card", messageId: "message" }; },
      updateStreamingCard: update, finishStreamingCard: finish,
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(delta(" FINAL"));
    const closed = outbox.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closed;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it.each(["send-timeout", "invalid-response"] as const)("does not create duplicate messages after uncertain stream creation: %s", async (code) => {
    vi.useFakeTimers();
    const post = vi.fn(async () => {});
    const create = vi.fn(async () => { throw new FeishuMessageError(code, "fixture"); });
    const footers: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {}, sendPost: post, createStreamingCard: create,
      sendMarkdownCard: async (_id, body) => { footers.push(body); },
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "partial FINAL", "item-1"));
    outbox.handle(turnCompleted());
    await outbox.close();
    expect(create).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(footers).toEqual([turnCompletedMarkdown]);
  });

  it("delivers the footer even when a fast static body and its fallback fail", async () => {
    vi.useFakeTimers();
    const footers: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {},
      sendMarkdownCard: async (_id, text) => {
        if (text === turnCompletedMarkdown) { footers.push(text); return; }
        throw new FeishuMessageError("card-create-failed", "fixture");
      },
      sendPost: async () => { throw new FeishuMessageError("send-failed", "fixture"); },
    }, pino({ level: "silent" }));
    outbox.handle(delta("short"));
    outbox.handle(completed({}, "short", "item-1"));
    outbox.handle(turnCompleted());
    await outbox.close();
    expect(footers).toEqual([turnCompletedMarkdown]);
  });

  it("stops remaining fallback chunks after the close deadline", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const posts: string[] = [];
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {},
      createStreamingCard: async () => { throw new FeishuMessageError("card-create-failed", "fixture"); },
      sendPost: async (_id, text) => { posts.push(text); if (posts.length === 1) await blocked; },
    }, pino({ level: "silent" }));
    outbox.handle(delta("partial"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "中".repeat(14000), "item-1"));
    const closing = outbox.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(posts).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
  });

  it("streams coalesced deltas through one native CardKit card", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const updated: Array<{ content: string; sequence: number }> = [];
    const finished: Array<{ summary: string; sequence: number }> = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
        updateStreamingCard: async (_cardId, content, sequence) => {
          updated.push({ content, sequence });
        },
        finishStreamingCard: async (_cardId, sequence, summary) => {
          finished.push({ summary, sequence });
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("你好"));
    outbox.handle(delta("，世界"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("！"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "你好，世界！", "item-1"));
    await outbox.close();

    expect(created).toEqual(["你好，世界"]);
    expect(updated).toEqual([{
      content: "你好，世界！",
      sequence: 1,
    }]);
    expect(finished).toEqual([{
      summary: "你好，世界！",
      sequence: 2,
    }]);
    expect(posts).toEqual([]);
  });

  it("flushes pending streamed text before a visible operation result", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          operations.push(`operation:${markdown}`);
        },
        createStreamingCard: async (_chatId, initialText) => {
          operations.push(`stream:${initialText}`);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("先说明，再执行命令。"));
    outbox.handle(operationUpdated("completed"));
    await outbox.close();

    expect(operations[0]).toBe("stream:先说明，再执行命令。");
    expect(operations[1]).toMatch(/^operation:\*\*运行命令/u);
  });

  it("suppresses reasoning after a command operation starts", async () => {
    const reasoning: OutputEvent = {
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "模型正在准备命令",
      elapsedMs: 240_000,
      final: false,
    };
    const created: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return { cardId: "reasoning", messageId: "reasoning-message" };
        },
      },
      pino({ level: "silent" }),
    );

    void outbox.handle(reasoning);
    await outbox.handle(operationUpdated("running"));
    await outbox.close();

    expect(created).toEqual([]);
  });

  it("seals an already-created reasoning card without emitting an intermediate operation card", async () => {
    const finished: string[] = [];
    const operations: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          operations.push(markdown);
        },
        createStreamingCard: async () => ({ cardId: "reasoning", messageId: "reasoning-message" }),
        finishStreamingCard: async (_cardId, _sequence, summary) => {
          finished.push(summary);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 1_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await outbox.handle(operationUpdated("running"));
    await outbox.close();

    expect(finished).toHaveLength(1);
    expect(finished[0]).toContain("思考中");
    expect(operations).toHaveLength(0);
  });

  it("does not append a working footer to active Turn output", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const updated: string[] = [];
    const finished: string[] = [];
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
        updateStreamingCard: async (_cardId, content) => {
          updated.push(content);
        },
        finishStreamingCard: async (
          _cardId,
          _sequence,
          summary,
          footer?: string,
        ) => {
          finished.push(`${summary}|${footer ?? ""}`);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle(delta("正在处理"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("。"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "正在处理。", "item-1"));
    outbox.handle(operationUpdated("completed"));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(created).toEqual(["正在处理"]);
    expect(updated).toEqual(["正在处理。"]);
    expect(finished).toEqual([
      `正在处理。|${turnCompletedMarkdown}`,
    ]);
    expect(markdownCards[0]).not.toContain("工作中");
    expect(markdownCards.at(-1)).toContain("**运行命令 · 已完成**");
  });

  it("uses the full streaming element budget without a footer", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
      },
      pino({ level: "silent" }),
    );
    const text = "长".repeat(5_000);

    outbox.handle(threadStatus("active"));
    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(created).toEqual([text]);
  });

  it("sends a short reply without a working footer", async () => {
    vi.useFakeTimers();
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle(delta("短回复"));
    outbox.handle(completed({}, "短回复", "item-1"));
    await outbox.close();

    expect(markdownCards).toEqual(["短回复"]);
  });

  it("bounds concurrent native streaming states", async () => {
    vi.useFakeTimers();
    const createStreamingCard = vi.fn(async () => ({
      cardId: "7355372766134157313",
      messageId: "om_stream",
    }));
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        createStreamingCard,
        sendText: async () => {},
        sendPost: async () => {},
      },
      pino({ level: "silent" }),
    );

    for (let index = 0; index < 101; index += 1) {
      outbox.handle(delta("增量", `item-${index}`));
    }
    await vi.advanceTimersByTimeAsync(300);
    await outbox.close();

    expect(createStreamingCard).toHaveBeenCalledTimes(100);
  });

  it("keeps a reply as one static CardKit card when it completes before streaming starts", async () => {
    vi.useFakeTimers();
    const createStreamingCard = vi.fn(cardMethods.createStreamingCard);
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        createStreamingCard,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          throw new Error(`unexpected post fallback: ${markdown}`);
        },
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("短回复"));
    outbox.handle(completed({}, "短回复", "item-1"));
    await outbox.close();

    expect(createStreamingCard).not.toHaveBeenCalled();
    expect(markdownCards).toEqual(["短回复"]);
  });

  it("logs and safely falls back to rich post when static CardKit creation fails", async () => {
    const posts: string[] = [];
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        sendMarkdownCard: async () => {
          throw new FeishuMessageError(
            "card-create-failed",
            "飞书静态卡片创建失败",
          );
        },
      },
      logger,
    );

    outbox.handle(completed({}, "飞书回复"));
    await outbox.close();

    expect(posts).toEqual(["飞书回复"]);
    expect(warn).toHaveBeenCalledWith(
      {
        component: "Feishu",
        fallback: "post",
        accountId: "cli_app",
        conversationId: "oc_chat",
        deliveryId: expect.any(String),
        eventType: "text.completed",
        itemId: "飞书回复",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      "飞书静态 CardKit 创建失败，已降级为富文本",
    );
  });

  it("does not duplicate a message after an ambiguous static CardKit send failure", async () => {
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        sendMarkdownCard: async () => {
          throw new FeishuMessageError("send-failed", "飞书消息发送失败");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, "飞书回复"));
    await outbox.close();

    expect(posts).toEqual([]);
  });

  it("falls back to the complete rich post after streaming creation fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async () => {
          throw new FeishuMessageError("card-create-failed", "stream failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("正文"));
    outbox.handle(completed({}, "部分正文", "item-1"));
    await outbox.close();

    expect(posts).toEqual(["部分正文"]);
  });

  it("marks a bounded rich-post fallback as truncated after streaming creation fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async () => {
          throw new FeishuMessageError("card-create-failed", "stream failed");
        },
      },
      pino({ level: "silent" }),
    );
    const text = "长".repeat(30_000);

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(posts).toHaveLength(4);
    expect(posts.at(-1)).toContain("[内容过长，已截断]");
  });

  it("uses the final short reply as the truncation source after streaming creation fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async () => {
          throw new FeishuMessageError("card-create-failed", "stream failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("长".repeat(30_000)));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "最终短回复", "item-1"));
    await outbox.close();

    expect(posts).toEqual(["最终短回复"]);
  });

  it("falls back to the complete rich post after a streaming update fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const finishStreamingCard = vi.fn(async () => {});
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        updateStreamingCard: async () => {
          throw new Error("stream update failed");
        },
        finishStreamingCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("正文"));
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle(completed({}, "部分正文", "item-1"));
    await outbox.close();

    expect(finishStreamingCard).toHaveBeenCalledWith(
      "7355372766134157313",
      2,
      "部分",
      undefined,
      expect.any(AbortSignal),
    );
    expect(posts).toEqual(["部分正文"]);
  });

  it("skips a rate-limited intermediate frame and continues the stream", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const updates: Array<{ content: string; sequence: number }> = [];
    const finishStreamingCard = vi.fn(async () => {});
    let updateCount = 0;
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        updateStreamingCard: async (_cardId, content, sequence) => {
          updates.push({ content, sequence });
          updateCount += 1;
          if (updateCount === 1) {
            throw new FeishuMessageError(
              "rate-limited",
              "飞书流式卡片更新请求受限",
            );
          }
        },
        finishStreamingCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("继续"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "部分正文继续", "item-1"));
    await outbox.close();

    expect(updates).toEqual([
      { content: "部分正文", sequence: 1 },
      { content: "部分正文继续", sequence: 2 },
    ]);
    expect(finishStreamingCard).toHaveBeenCalledWith(
      "7355372766134157313",
      3,
      "部分正文继续",
      undefined,
      expect.any(AbortSignal),
    );
    expect(posts).toEqual([]);
  });

  it("rolls a long fenced reply into bounded native streaming cards", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const finished: string[] = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
        finishStreamingCard: async (_cardId, _sequence, summary) => {
          finished.push(summary);
        },
      },
      pino({ level: "silent" }),
    );
    const text = `\`\`\`ts\n${"const value = 1;\n".repeat(400)}\`\`\``;

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(created).toHaveLength(2);
    expect(created.every((part) => [...part].length <= 5_000)).toBe(true);
    expect(created[0]).toMatch(/\n```$/u);
    expect(created[1]).toMatch(/^```ts\n/u);
    expect(finished).toHaveLength(2);
    expect(posts).toEqual([]);
  });

  it("appends a complete text file after an oversized streaming reply", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const files: Buffer[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          operations.push(`text:${text}`);
        },
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          operations.push(`static:${markdown}`);
        },
        createStreamingCard: async (_chatId, initialText) => {
          operations.push(`create:${initialText}`);
          return {
            cardId: `73553727661341573${operations.length}`,
            messageId: `om_stream_${operations.length}`,
          };
        },
        finishStreamingCard: async () => {
          operations.push("finish");
        },
        sendFile: async (_chatId, fileName, file) => {
          operations.push(`file:${fileName}`);
          files.push(file);
        },
      },
      pino({ level: "silent" }),
    );
    const text = "流式长回复".repeat(6_000);

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(operations.at(-1)).toBe("file:codex-final-answer.txt");
    expect(files).toEqual([Buffer.from(text, "utf8")]);
  });

  it("keeps streaming cards and fallback posts within one five-message budget", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const markdownCards: string[] = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
      },
      pino({ level: "silent" }),
    );
    const text = ["甲", "乙", "丙", "丁", "戊", "己"]
      .map((character) => character.repeat(5_000))
      .join("");

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(created).toHaveLength(4);
    expect(markdownCards).toHaveLength(1);
    expect(posts).toEqual([]);
    expect(markdownCards[0]).toMatch(/\[内容过长，已截断\]$/u);
    const displayedText = [
      ...created,
      markdownCards[0]!.replace(/\n\n\[内容过长，已截断\]$/u, ""),
    ].join("");
    expect(text.startsWith(displayedText)).toBe(true);
    expect(
      created.length + markdownCards.length + posts.length,
    ).toBeLessThanOrEqual(5);
  });

  it("reserves the fifth message for a corrected final reply", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("长".repeat(30_000)));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "最终校正回复", "item-1"));
    await outbox.close();

    expect(created).toHaveLength(4);
    expect(posts).toEqual(["最终校正回复"]);
    expect(created.length + posts.length).toBeLessThanOrEqual(5);
  });

  it("finishes an active native stream before a Turn completion status", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    let resolveInitialFinish!: () => void;
    const initialFinish = new Promise<void>((resolve) => {
      resolveInitialFinish = resolve;
    });
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          operations.push(`text:${text}`);
        },
        sendPost: async (_chatId, text) => {
          operations.push(`post:${text}`);
        },
        sendMarkdownCard: async (_chatId, text) => {
          operations.push(`static:${text}`);
        },
        createStreamingCard: async (_chatId, initialText) => {
          operations.push(`create:${initialText}`);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
        finishStreamingCard: async (
          _cardId,
          _sequence,
          summary,
          footer?: string,
        ) => {
          operations.push(`finish:${summary}|${footer ?? ""}`);
          if (footer === undefined) {
            resolveInitialFinish();
          }
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "部分正文", "item-1"));
    await initialFinish;
    await Promise.resolve();
    await Promise.resolve();
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(operations).toEqual([
      "create:部分正文",
      "finish:部分正文|",
      `finish:部分正文|${turnCompletedMarkdown}`,
    ]);
  });

  it("falls back to a static completion status when finishing a stream fails", async () => {
    vi.useFakeTimers();
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        finishStreamingCard: async () => {
          throw new Error("stream finish failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards).toEqual([turnCompletedMarkdown]);
    expect(vi.getTimerCount()).toBe(0);
  });

});
