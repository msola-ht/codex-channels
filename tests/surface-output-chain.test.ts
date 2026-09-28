import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GrammyError, type Api } from "grammy";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus/index.js";
import { conversationTargetKey, surfaceAccountKey, type OutputEvent } from "../src/conversation-core/index.js";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import type { DeliveryRecord } from "../src/delivery/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import { FeishuOutbox } from "../src/surfaces/feishu/outbox.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";
import type { FeishuMessagePort } from "../src/surfaces/feishu/outbox-message-port.js";
import type { DeliveryCheckpoint } from "../src/surfaces/delivery-receipt.js";
import type { SurfaceAdapter } from "../src/surfaces/index.js";

const logger = pino({ level: "silent" });
const target = { surface: "telegram" as const, accountId: "default", conversationId: "chat" };
const base = { target, threadId: "thread", turnId: "turn" };
const answer: OutputEvent = { ...base, type: "text.completed", itemId: "answer", text: "full answer", phase: "final_answer" };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.each(["html", "rich", "commentary"] as const)("confirms an unchanged Telegram %s body and drains its completion", async (format) => {
  const edit = vi.fn(async () => { throw new GrammyError("unchanged", {
    ok: false, error_code: 400, description: "Bad Request: message is not modified",
  }, "editMessageText", {}); });
  const f = await fixture(false, "telegram", false, false, undefined, {
    telegramEdit: edit, telegramFormat: format === "rich" ? "rich" : "html",
  });
  const phase = format === "commentary" ? "commentary" : "final_answer";
  try {
    f.output.publish({ ...base, type: "text.delta", itemId: "answer", text: "full answer", phase });
    await vi.waitFor(() => expect(f.sent).toEqual(["full answer"]), { timeout: 3000 });
    f.output.publish({ ...answer, phase });
    f.output.publish({ ...base, type: "turn.completed", status: "completed" });
    await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
    expect(edit).toHaveBeenCalledOnce();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain("本次运行");
    expect(f.checkpoints.filter((value) => value.operation === "editMessageText").map((value) => value.state)).toEqual(["started", "confirmed"]);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
  const stored = new SqliteDeliveryJournal(f.directory);
  try { expect(stored.execute({ type: "summary" })).toMatchObject({ records: 0 }); }
  finally { stored.close(); }
});

it("omits live empty commentary before admission without blocking the nonempty result", async () => {
  const f = await fixture();
  try {
    f.output.publish({ ...answer, text: " \n ", phase: "commentary" });
    f.output.publish({ ...answer, itemId: "visible" });
    await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
    expect(f.rendered).toEqual([{ ...answer, itemId: "visible" }]);
    expect(f.sent).toEqual(["full answer"]);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it("settles a previously persisted empty commentary after restart without inventing a platform checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codexc-empty-commentary-"));
  directories.push(directory);
  const stored = new SqliteDeliveryJournal(directory);
  try {
    for (const [id, event] of [["empty", { ...answer, text: " ", phase: "commentary" }], ["answer", answer]] as const) {
      stored.execute({ type: "submit", value: { id, account: surfaceAccountKey(target.surface, target.accountId),
        conversation: conversationTargetKey(target), payload: JSON.stringify({ version: 1, event, owner: "actor" }) } });
    }
  } finally { stored.close(); }
  const f = await fixture(false, "telegram", false, false, directory);
  try {
    await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
    expect(f.sent).toEqual(["full answer"]);
    expect(f.checkpoints.map((value) => value.state)).toEqual(["started", "confirmed"]);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
  const reopened = new SqliteDeliveryJournal(directory);
  try { expect(reopened.execute({ type: "summary" })).toMatchObject({ records: 0 }); }
  finally { reopened.close(); }
});

it("keeps a Feishu completed card scoped to its original Conversation without requiring a disconnect", async () => {
  const finished = vi.fn(async () => {});
  const create = vi.fn(async () => ({ cardId: "old-card", messageId: "old-message" }));
  const f = await fixture(false, "feishu", false, false, undefined, { feishu: { createStreamingCard: create, finishStreamingCard: finished } });
  try {
    f.output.publish({ ...base, target: f.target, type: "text.delta", itemId: "answer", text: "full answer", phase: "final_answer" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    f.output.publish({ ...answer, target: f.target });
    await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    expect(finished).toHaveBeenCalledOnce();
    const next = { ...f.target, conversationId: "new-chat" };
    f.output.publish({ ...base, target: next, type: "turn.completed", status: "completed" });
    await f.manager.waitForPersistentOutput(next, AbortSignal.timeout(3000));
    expect(finished).toHaveBeenCalledOnce();
    expect(f.sentTargets).toEqual(["new-chat"]);
    expect(f.sent[0]).toContain("本次运行");
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["cached", "in-flight", "queued-completion"] as const)("invalidates Feishu %s card reuse on disconnect while preserving the result", async (cut) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const finished = vi.fn(async () => { if (cut === "in-flight") await blocked; });
  const create = vi.fn(async () => ({ cardId: "old-card", messageId: "old-message" }));
  let barrierStarted = false;
  const f = await fixture(false, "feishu", false, false, undefined, { feishu: {
    createStreamingCard: create, finishStreamingCard: finished,
    sendText: async () => { if (cut === "queued-completion" && !barrierStarted) { barrierStarted = true; await blocked; } },
  } });
  try {
    f.output.publish({ ...base, target: f.target, type: "text.delta", itemId: "answer", text: "full answer", phase: "final_answer" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    f.output.publish({ ...answer, target: f.target });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    if (cut !== "in-flight") await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    if (cut === "queued-completion") {
      f.outbox.handle({ target: f.target, type: "warning", message: "barrier" });
      await vi.waitFor(() => expect(barrierStarted).toBe(true));
      f.output.publish({ ...base, target: f.target, type: "turn.completed", status: "completed" });
      await vi.waitFor(() => expect(f.rendered.at(-1)?.type).toBe("turn.completed"));
    }
    f.output.publish({ target: f.target, threadId: "thread", type: "connection.lost", message: "lost" });
    release();
    if (cut !== "queued-completion") f.output.publish({ ...base, target: f.target, type: "turn.completed", status: "completed" });
    await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    expect(finished).toHaveBeenCalledOnce();
    expect(f.sent.filter((value) => value.includes("本次运行"))).toHaveLength(1);
    expect(f.faults).toEqual([]);
  } finally { release(); await f.close(); }
});

it.each(["telegram", "feishu"] as const)("does not reuse a different Conversation's %s stream or reply target", async (platform) => {
  const edit = vi.fn(async () => true);
  const reply = vi.fn(async () => "reply");
  const finished = vi.fn(async () => {});
  const f = await fixture(false, platform, false, false, undefined, {
    telegramEdit: edit, feishu: { replyMarkdownCard: reply, createStreamingReplyCard: async () => ({ cardId: "old-card", messageId: "old-message" }), finishStreamingCard: finished },
  });
  try {
    if (f.outbox instanceof TelegramOutbox) f.outbox.prepareTurnReplyTarget("chat", 42);
    else f.outbox.prepareTurnReplyTarget("chat", "old-source");
    f.output.publish({ ...base, target: f.target, type: "turn.started" });
    await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    f.output.publish({ ...base, target: f.target, type: "text.delta", itemId: "answer", text: "old text", phase: "final_answer" });
    await new Promise<void>((resolve) => setTimeout(resolve, platform === "telegram" ? 1100 : 400));
    const previousReplies = reply.mock.calls.length;
    const previousSends = f.sent.length;
    const next = { ...f.target, conversationId: "new-chat" };
    f.output.publish({ ...answer, target: next });
    f.output.publish({ ...base, target: next, type: "turn.completed", status: "completed" });
    await f.manager.waitForPersistentOutput(next, AbortSignal.timeout(3000));
    expect(f.sent.slice(previousSends).join("\n")).toContain("full answer");
    expect(f.sent.slice(previousSends).join("\n")).toContain("本次运行");
    expect(f.sentTargets.slice(previousSends)).toEqual(["new-chat", "new-chat"]);
    expect(edit).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(previousReplies);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("keeps %s cached state messages and terminal operations within their recipient", async (platform) => {
  const created: string[] = [];
  const edited: string[] = [];
  const createCard = async (chat: string) => { created.push(chat); return `message-${chat}`; };
  const f = await fixture(false, platform, false, false, undefined, {
    telegramEdit: async (...args) => { edited.push(String(args[0])); return true; },
    feishu: {
      sendCard: createCard, updateCard: async (id) => { edited.push(id); },
      createStreamingCard: async (chat) => ({ cardId: `card-${chat}`, messageId: await createCard(chat) }),
      updateStreamingCard: async (id) => { edited.push(id); }, finishStreamingCard: async () => {},
    },
  });
  try {
    for (const conversationId of ["chat", "new-chat"]) {
      const t = { ...f.target, conversationId };
      const events: OutputEvent[] = [
        { ...base, target: t, type: "plan.updated", explanation: "plan", steps: [{ step: "work", status: "inProgress" }] },
        { ...base, target: t, type: "turn.reasoning", elapsedMs: 1000, summary: "" },
        { ...base, target: t, type: "operation.updated", operation: { itemId: "cua", kind: "mcpTool", action: "computerUse", status: "running", detail: "browse" } },
      ];
      for (const event of events) {
        f.output.publish(event);
        // The real routing queue must settle the state before advancing lifecycle.
        await vi.waitFor(() => expect(f.rendered.filter((value) => value.type === event.type && value.target.conversationId === conversationId)).toHaveLength(1));
        await vi.waitFor(() => expect((platform === "telegram" ? f.sentTargets : created).filter((chat) => chat === conversationId).length).toBeGreaterThanOrEqual(events.indexOf(event) + 1), { timeout: 2000 });
      }
      f.output.publish({ ...base, target: t, type: "operation.updated", operation: { itemId: "cua", kind: "mcpTool", action: "computerUse", status: "completed", detail: "browse" } });
      await f.manager.waitForPersistentOutput(t, AbortSignal.timeout(3000));
      if (conversationId === "chat") edited.length = 0;
    }
    expect(edited.length).toBeGreaterThan(0);
    expect(edited.every((id) => id.includes("new-chat"))).toBe(true);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("does not seal the old recipient's %s reasoning while delivering a new recipient's operation", async (platform) => {
  const edit = vi.fn(async () => true);
  const create = vi.fn(async () => ({ cardId: "old-card", messageId: "old-message" }));
  const finish = vi.fn(async () => {});
  const f = await fixture(false, platform, false, false, undefined, {
    telegramEdit: edit, feishu: { createStreamingCard: create, finishStreamingCard: finish },
  });
  try {
    f.output.publish({ ...base, target: f.target, type: "turn.reasoning", elapsedMs: 1000, summary: "" });
    await vi.waitFor(() => expect(platform === "telegram" ? f.sent.length : create.mock.calls.length).toBe(1));
    const next = { ...f.target, conversationId: "new-chat" };
    f.output.publish({ ...base, target: next, type: "operation.updated", operation: {
      itemId: "command", kind: "command", status: "completed", detail: "pwd", exitCode: 0,
    } });
    await f.manager.waitForPersistentOutput(next, AbortSignal.timeout(3000));
    expect(f.sentTargets.at(-1)).toBe("new-chat");
    expect(edit).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("retains the queued %s final after disconnect clears its live stream", async (platform) => {
  const f = await fixture(true, platform);
  try {
    f.outbox.handle({ target: f.target, type: "warning", message: "barrier" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ ...base, target: f.target, type: "text.delta", itemId: "answer", text: "full ", phase: "final_answer" });
    await vi.waitFor(() => expect(f.rendered.map((event) => event.type)).toContain("text.delta"));
    f.output.publish({ ...answer, target: f.target });
    await vi.waitFor(() => expect(f.rendered.map((event) => event.type)).toContain("text.completed"));
    f.output.publish({ target: f.target, threadId: "thread", type: "connection.lost", message: "lost" });
    f.release();
    await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    expect(f.sent).toHaveLength(3);
    expect(f.sent[1]).toContain("full answer");
    expect(f.sent[2]).toContain("lost");
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("keeps an unknown %s final across restart and fences later input mirrors", async (platform) => {
  const f = await fixture(true, platform, false, true);
  try {
    f.outbox.handle({ target: f.target, type: "warning", message: "barrier" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ ...base, target: f.target, type: "text.delta", itemId: "answer", text: "full ", phase: "final_answer" });
    await vi.waitFor(() => expect(f.rendered.map((event) => event.type)).toContain("text.delta"));
    f.output.publish({ ...answer, target: f.target });
    await vi.waitFor(() => expect(f.rendered.map((event) => event.type)).toContain("text.completed"));
    f.output.publish({ target: f.target, threadId: "thread", type: "connection.lost", message: "lost" });
    f.release();
    await vi.waitFor(() => expect(f.faults).toEqual(["delivery-uncertain"]));
    expect(f.sent).toHaveLength(2);
  } finally { await f.close(); }
  const recovered = await fixture(false, platform, false, false, f.directory);
  try {
    recovered.output.publish({ ...base, target: f.target, type: "user.message", itemId: "input", text: "CLI input must not jump" });
    recovered.output.publish({ ...answer, target: f.target, itemId: "later", text: "later result" });
    // Another Conversation can drain, proving recovery is running while this one remains fenced.
    const independent = { ...f.target, conversationId: "independent" };
    recovered.output.publish({ ...answer, target: independent, text: "independent result" });
    await recovered.manager.waitForPersistentOutput(independent, AbortSignal.timeout(3000));
    expect(recovered.sent).toEqual(["independent result"]);
  } finally { await recovered.close(); }
  const stored = new SqliteDeliveryJournal(f.directory);
  try {
    expect(stored.execute({ type: "summary" })).toMatchObject({ records: 3, uncertain: 1, pending: 2 });
    const records = stored.execute({ type: "list", after: 0, limit: 100 }) as Array<Omit<DeliveryRecord, "payload">>;
    // Resolve only this stopped, isolated fixture to inspect the retained encrypted payload.
    expect(stored.execute({ type: "resolve", id: records[0]!.id, action: "retry" })).toBe(true);
    const first = stored.execute({ type: "next", excluded: [] }) as DeliveryRecord;
    expect(first.payload).toContain("full answer");
  } finally { stored.close(); }
});

it.each([false, true])("releases a suspended account's snapshots without deleting its durable result (online=%s)", async (online) => {
  const directory = mkdtempSync(join(tmpdir(), "codexc-isolation-chain-"));
  directories.push(directory);
  const output = new EventBus<OutputEvent>(logger);
  const delivered: string[] = [];
  const faults: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const surfaces: SurfaceAdapter[] = ["a", "b"].map((accountId) => ({
    surface: "telegram", accountId,
    output: {
      handle: () => {},
      deliverSnapshot: async () => {
        if (accountId === "a") { started = true; await blocked; }
        delivered.push(accountId);
      },
      deliver: async () => {},
    },
    interactions: { request: async () => ({ type: "approval", approved: false }) },
    start: async () => { if (accountId === "a" && !online) throw new Error("offline fixture"); },
    stop: async () => {},
    deliverConfigurationChange: async () => {},
  }));
  const manager = new SurfaceManager(surfaces, output, logger, undefined, {
    retryDelaysMs: [60_000],
    persistence: { directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
      owner: () => "actor", authorized: () => true, fault: (code) => { faults.push(code); } },
  });
  const accountTarget = { ...target, accountId: "a" };
  try {
    await manager.start();
    for (let i = 0; i < 512; i++) output.publish({ ...base, target: accountTarget, type: "operation.updated",
      operation: { itemId: String(i), kind: "command", status: "running" } });
    if (online) await vi.waitFor(() => expect(started).toBe(true));
    output.publish({ ...answer, target: accountTarget });
    manager.suspendPersistentAccount(surfaceAccountKey("telegram", "a"));
    output.publish({ target: { ...target, accountId: "b" }, type: "account.updated", authMode: "chatgpt", planType: "pro" });
    await vi.waitFor(() => expect(delivered).toEqual(["b"]));
    expect(faults).toEqual([]);
    expect(manager.acceptsExecution(accountTarget)).toBe(false);
    release();
  } finally { release(); await manager.stop(); await output.close(); }
  const stored = new SqliteDeliveryJournal(directory);
  try { expect(stored.execute({ type: "summary" })).toMatchObject({ records: 1, pending: 1 }); }
  finally { stored.close(); }
});

async function fixture(block = false, platform: "telegram" | "feishu" = "telegram", failFirst = false, failAnswer = false, existingDirectory?: string,
  options: { telegramEdit?: (...args: unknown[]) => Promise<unknown>; telegramFormat?: "html" | "rich"; feishu?: Partial<FeishuMessagePort> } = {}) {
  const target = { surface: platform, accountId: "default", conversationId: "chat" };
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), "codexc-state-chain-"));
  if (!existingDirectory) directories.push(directory);
  const sent: string[] = [];
  const sentTargets: string[] = [];
  const checkpoints: DeliveryCheckpoint[] = [];
  const rendered: OutputEvent[] = [];
  const observed: OutputEvent[] = [];
  const faults: string[] = [];
  let release!: () => void;
  let authorized = true;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const send = async (chat: string, text: string) => {
      sent.push(text);
      sentTargets.push(chat);
      if (block && sent.length === 1) await blocked;
      if (failFirst && sent.length === 1) throw new Error("unknown send outcome");
      if (failAnswer && text.includes("full answer")) throw new Error("unknown answer outcome");
      return String(sent.length);
  };
  const outbox = platform === "telegram"
    ? new TelegramOutbox({ sendMessage: async (chat: string, text: string) => ({ message_id: Number(await send(chat, text)) }),
      editMessageText: options.telegramEdit ?? (async () => true),
      sendChatAction: async () => true } as unknown as Api, logger, undefined, { planUpdatesEnabled: true,
        ...(options.telegramFormat ? { finalMessageFormat: options.telegramFormat } : {}) })
    : new FeishuOutbox("default", {
      sendText: async (chat, text) => { await send(chat, text); }, sendPost: async (chat, text) => { await send(chat, text); },
      sendMarkdownCard: send, sendCard: async () => "card", updateCard: async () => {},
      createStreamingCard: async (chat, text) => ({ cardId: "card", messageId: await send(chat, text) }),
      updateStreamingCard: async () => {}, finishStreamingCard: async () => {},
      ...options.feishu,
    }, logger, { planUpdatesEnabled: true });
  const output = new EventBus<OutputEvent>(logger);
  const surface: SurfaceAdapter = {
    surface: platform, accountId: "default",
    output: {
      observe: (event) => { observed.push(event); outbox.observe(event); },
      retains: (event) => outbox.retains(event),
      handle: (event) => { rendered.push(event); outbox.handle(event); },
      deliverSnapshot: (event, signal, authorized) => { rendered.push(event); return outbox.deliverSnapshot(event, signal, authorized); },
      deliver: (event, signal, checkpoint) => { rendered.push(event); return outbox.deliver(event, signal, async (value) => {
        checkpoints.push(value); await checkpoint(value);
      }); },
    },
    interactions: { request: async () => ({ type: "approval", approved: false }) },
    start: async () => {}, stop: () => outbox.close(), deliverConfigurationChange: async () => {},
  };
  const manager = new SurfaceManager([surface], output, logger, undefined, {
    persistence: { directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
      owner: () => "actor", authorized: () => authorized, fault: (code) => { faults.push(code); } },
  });
  await manager.start();
  return { directory, target, outbox, output, manager, rendered, observed, sent, sentTargets, checkpoints, faults, release, revoke: () => { authorized = false; },
    close: async () => { release(); await manager.stop(); await output.close(); } };
}

it("keeps start before a same-tick completed answer while observing lifecycle immediately", async () => {
  const f = await fixture();
  try {
    f.output.publish({ ...base, type: "turn.started" });
    f.output.publish(answer, true);
    expect(f.observed.map((event) => event.type)).toEqual(["turn.started", "text.completed"]);
    await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
    expect(f.rendered.map((event) => event.type)).toEqual(["turn.started", "text.completed"]);
    expect(f.sent).toHaveLength(2);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it("retains lifecycle notices behind an in-flight answer and coalesces account state", async () => {
  const f = await fixture(true);
  try {
    f.output.publish(answer, true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const notices: OutputEvent[] = [
      { ...base, type: "turn.started" },
      { ...base, type: "subagent.spawned", agentThreadId: "child", agentPath: "/child" },
      { target, threadId: "thread", type: "connection.lost", message: "disconnected" },
      { target, threadId: "thread", type: "connection.restored", message: "restored" },
    ];
    for (const event of notices) f.output.publish(event, true);
    for (const planType of ["free", "plus", "pro"] as const) f.output.publish({ target, type: "account.updated", authMode: "chatgpt", planType }, true);
    expect(f.observed.filter((event) => event.type === "connection.lost")).toHaveLength(1);
    expect(f.rendered).toHaveLength(1);
    f.release();
    await vi.waitFor(() => expect(f.rendered).toHaveLength(6));
    expect(f.rendered.slice(1, 5).map((event) => event.type)).toEqual(notices.map((event) => event.type));
    expect(f.rendered.at(-1)).toMatchObject({ type: "account.updated", planType: "pro" });
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["completed", "disconnected"] as const)("expires pending running snapshots when %s before delivery resumes", async (ending) => {
  const f = await fixture(true);
  try {
    f.output.publish(answer, true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ ...base, type: "turn.reasoning", summary: "", elapsedMs: 100 });
    f.output.publish({ ...base, type: "plan.updated", explanation: null, steps: [{ step: "work", status: "inProgress" }] });
    f.output.publish({ ...base, type: "operation.updated", operation: { itemId: "command", kind: "command", status: "running", detail: "work" } });
    f.output.publish(ending === "completed" ? { ...base, type: "turn.completed", status: "completed" }
      : { target, threadId: "thread", type: "connection.lost", message: "disconnected" }, true);
    f.release();
    await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
    expect(f.rendered.map((event) => event.type)).toEqual(["text.completed", ending === "completed" ? "turn.completed" : "connection.lost"]);
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it("rechecks recipient ownership before rendering a deferred snapshot", async () => {
  const f = await fixture(true);
  try {
    f.output.publish(answer, true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ target, type: "account.updated", authMode: "chatgpt", planType: "pro" }, true);
    f.revoke();
    f.release();
    await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.rendered.map((event) => event.type)).toEqual(["text.completed"]);
  } finally { await f.close(); }
});

it.each(["entries", "bytes"] as const)("reports deferred snapshot %s exhaustion without an unbounded queue", async (limit) => {
  const f = await fixture(true);
  try {
    f.output.publish(answer, true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    if (limit === "entries") {
      for (let i = 0; i < 513; i++) {
        f.output.publish({ ...base, type: "operation.updated", operation: { itemId: String(i), kind: "command", status: "running" } });
      }
    } else {
      f.output.publish({ ...base, type: "plan.updated", explanation: "x".repeat(8 * 1024 * 1024), steps: [] });
    }
    expect(f.faults).toEqual(["mailbox-full"]);
    expect(f.rendered).toHaveLength(1);
  } finally { await f.close(); }
});

// No durable backlog: the platform queue itself is the bottleneck.
it.each(["telegram", "feishu"] as const)("keeps only the in-flight and latest %s account snapshots until actual send completion", async (platform) => {
  const f = await fixture(true, platform);
  try {
    f.output.publish({ target: f.target, type: "account.updated", authMode: "chatgpt", planType: "free" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    for (let i = 0; i < 600; i++) {
      f.output.publish({ target: f.target, type: "account.updated", authMode: "chatgpt", planType: i === 599 ? "pro" : "plus" });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(f.rendered).toHaveLength(1);
    f.release();
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.rendered.at(-1)).toMatchObject({ type: "account.updated", planType: "pro" });
    expect(f.sent.at(-1)).toContain("Pro");
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("rechecks %s snapshot ownership after it has entered the platform queue", async (platform) => {
  const f = await fixture(true, platform);
  try {
    f.outbox.handle({ target: f.target, type: "warning", message: "barrier" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ target: f.target, type: "account.updated", authMode: "chatgpt", planType: "pro" });
    await vi.waitFor(() => expect(f.rendered).toHaveLength(1));
    f.revoke();
    f.release();
    await f.close();
    expect(f.sent).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("orders the actual start/input/result/completion sequence on %s", async (platform) => {
  const f = await fixture(false, platform);
  try {
    f.output.publish({ ...base, target: f.target, type: "turn.started" });
    f.output.publish({ ...base, target: f.target, type: "user.message", itemId: "input", text: "CLI input" });
    f.output.publish({ ...answer, target: f.target }, true);
    f.output.publish({ ...base, target: f.target, type: "turn.completed", status: "completed" });
    await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    expect(f.rendered.map((event) => event.type)).toEqual(["turn.started", "user.message", "text.completed", "turn.completed"]);
    const visible = f.sent.join("\n");
    expect(visible.indexOf("CLI input")).toBeLessThan(visible.indexOf("full answer"));
    expect(visible).toContain("CLI input");
    expect(visible).toContain("full answer");
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it.each(["telegram", "feishu"] as const)("continues to the latest %s state after an unknown send result without replaying the failed state", async (platform) => {
  const f = await fixture(true, platform, true);
  try {
    f.output.publish({ target: f.target, type: "account.updated", authMode: "chatgpt", planType: "free" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ target: f.target, type: "account.updated", authMode: "chatgpt", planType: "pro" });
    f.release();
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]).toContain("Pro");
    expect(f.faults).toEqual([]);
  } finally { await f.close(); }
});

it("charges both the in-flight payload and its pending replacement to the memory budget", async () => {
  const f = await fixture(true);
  try {
    f.output.publish({ ...base, type: "plan.updated", explanation: "x".repeat(5 * 1024 * 1024), steps: [] });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ ...base, type: "plan.updated", explanation: "y".repeat(4 * 1024 * 1024), steps: [] });
    expect(f.faults).toEqual(["mailbox-full"]);
  } finally { await f.close(); }
});

it("does not let a failed initial plan suppress a later live plan update", async () => {
  const f = await fixture(true, "telegram", true);
  try {
    f.output.publish({ ...base, type: "plan.updated", explanation: "initial", steps: [{ step: "work", status: "inProgress" }] });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ ...base, type: "plan.updated", explanation: "latest plan", steps: [{ step: "work", status: "inProgress" }] });
    f.release();
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]).toContain("latest plan");
  } finally { await f.close(); }
});

it.each([
  ["telegram", "connection.lost"], ["feishu", "connection.lost"],
  ["telegram", "connection.restored"], ["feishu", "connection.restored"],
] as const)("retains an unknown %s %s notice without fencing answers, snapshots or interaction waits", async (platform, type) => {
  const f = await fixture(true, platform, true);
  try {
    f.output.publish({ target: f.target, threadId: "thread", type, message: "connection notice" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.output.publish({ ...answer, target: f.target });
    f.output.publish({ target: f.target, type: "account.updated", authMode: "chatgpt", planType: "pro" });
    f.release();
    await f.manager.waitForPersistentOutput(f.target, AbortSignal.timeout(3000));
    await vi.waitFor(() => expect(f.sent.some((text) => text.includes("Pro"))).toBe(true));
    expect(f.sent.filter((text) => text.includes("full answer"))).toHaveLength(1);
    expect(f.faults).toEqual(["delivery-uncertain"]);
  } finally { await f.close(); }
  const stored = new SqliteDeliveryJournal(f.directory);
  let retainedBytes: number;
  try {
    expect(stored.execute({ type: "summary" })).toMatchObject({ records: 1, uncertain: 1 });
    const rows = stored.execute({ type: "list", after: 0, limit: 100 }) as DeliveryRecord[];
    expect(rows[0]?.progress.map((checkpoint) => checkpoint.state)).toEqual(["started"]);
    retainedBytes = rows[0]!.bytes;
  } finally { stored.close(); }
  const restarted = await fixture(false, platform, false, false, f.directory);
  try {
    restarted.output.publish({ ...answer, target: restarted.target, itemId: "after-restart" });
    await restarted.manager.waitForPersistentOutput(restarted.target, AbortSignal.timeout(3000));
    expect(restarted.sent).toEqual(["full answer"]);
  } finally { await restarted.close(); }
  const retained = new SqliteDeliveryJournal(f.directory);
  try { expect(retained.execute({ type: "summary" })).toMatchObject({ records: 1, uncertain: 1, bytes: retainedBytes }); }
  finally { retained.close(); }
});

it.each(["connection", "answer", "warning", "blocked"] as const)("rebuilds only eligible connection barriers after an interrupted %s send", async (kind) => {
  const directory = mkdtempSync(join(tmpdir(), "codexc-recovered-barrier-"));
  directories.push(directory);
  const store = new SqliteDeliveryJournal(directory);
  const event: OutputEvent = kind === "answer" ? answer : kind === "warning"
    ? { target, type: "warning", message: "warning" }
    : { target, threadId: "thread", type: "connection.lost", message: "lost" };
  try {
    for (const [id, value] of [["first", event], ["next", answer]] as const) {
      store.execute({ type: "submit", value: { id, account: surfaceAccountKey(target.surface, target.accountId),
        conversation: conversationTargetKey(target), payload: JSON.stringify({ version: 1, owner: "actor", event: value }) } });
    }
    store.execute({ type: "state", id: "first", from: "pending", to: kind === "blocked" ? "blocked" : "sending" });
    if (kind !== "blocked") store.execute({ type: "checkpoint", id: "first", value: { operation: "send", state: "started" } });
  } finally { store.close(); }
  const f = await fixture(false, "telegram", false, false, directory);
  try {
    if (kind === "connection") {
      await f.manager.waitForPersistentOutput(target, AbortSignal.timeout(3000));
      expect(f.sent).toEqual(["full answer"]);
    } else {
      await expect(f.manager.waitForPersistentOutput(target, AbortSignal.timeout(100))).rejects.toThrow();
      expect(f.sent).toEqual([]);
    }
  } finally { await f.close(); }
  const retained = new SqliteDeliveryJournal(directory);
  try { expect(retained.execute({ type: "summary" })).toMatchObject({ records: kind === "connection" ? 1 : 2 }); }
  finally { retained.close(); }
});
