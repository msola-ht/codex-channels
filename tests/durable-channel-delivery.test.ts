import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import { DeliveryJournal, type SurfaceAdapter } from "../src/surfaces/index.js";
import { TelegramLifecycle } from "../src/surfaces/telegram/lifecycle.js";
import { FeishuInbox } from "../src/surfaces/feishu/inbox.js";

const logger = pino({ level: "silent" });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function journalFixture() {
  const directory = mkdtempSync(join(tmpdir(), "durable-channel-test-"));
  const journal = new DeliveryJournal(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => journal.close());
  return journal;
}

it("TG confirms 100 durable updates and reaches the next stop while the first chat is blocked", async () => {
  const journal = journalFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handled: number[] = [];
  const offsets: number[] = [];
  const updates = Array.from({ length: 101 }, (_, i) => ({ update_id: i + 1, message: {
    message_id: i + 1, date: 1, chat: { id: 1, type: "private" as const }, text: i === 100 ? "/stop" : "ordinary",
  } }));
  const bot = { botInfo: { username: "fixture" }, init: async () => {},
    handleUpdate: async (update: { update_id: number }) => { handled.push(update.update_id); if (update.update_id === 1) await gate; },
    api: { setMyCommands: async () => true,
      getUpdates: async ({ offset, limit }: { offset: number; limit: number }, signal: AbortSignal) => {
        offsets.push(offset);
        const found = updates.filter(update => update.update_id >= offset).slice(0, limit);
        if (found.length) return found;
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        return [];
      },
    },
  };
  const lifecycle = new TelegramLifecycle(bot as unknown as Bot, logger, undefined, undefined, { journal });
  lifecycle.start();
  try {
    await vi.waitFor(() => expect(handled).toContain(101));
    expect(offsets).toContain(101);
    expect(handled).not.toContain(2);
    expect(journal.usage().records).toBeGreaterThanOrEqual(99);
    release();
    await vi.waitFor(() => expect(journal.usage().records).toBe(0));
    expect(new Set(handled).size).toBe(101);
  } finally { release(); await lifecycle.stop(); }
});

it("Feishu acknowledges only durable admission and recovers accepted pending work with current authorization", async () => {
  const journal = journalFixture();
  const handle = vi.fn(async () => {});
  const access = { isAllowed: vi.fn(() => true) };
  const options = { journal, accountId: "cli_0123456789abcdef", access, handle, handleError: vi.fn(), handleCloseTimeout: vi.fn() };
  const event = { eventId: "e", appId: options.accountId, actorOpenId: "ou_actor", senderType: "user",
    messageId: "om_message", createTime: String(Date.now()), chatId: "oc_chat", chatType: "p2p", messageType: "text", content: '{"text":"private"}' };
  const inbox = new FeishuInbox(options);
  expect(inbox.receive(event)).toEqual({ status: "accepted" });
  expect(journal.usage().records).toBe(1);
  expect(handle).not.toHaveBeenCalled();
  await inbox.close();
  const recovered = new FeishuInbox(options);
  access.isAllowed.mockReturnValue(false);
  recovered.start();
  await vi.waitFor(() => expect(journal.usage().records).toBe(0));
  expect(handle).not.toHaveBeenCalled();
  await recovered.close();
  const failed = new FeishuInbox(options);
  access.isAllowed.mockReturnValue(true);
  vi.spyOn(journal, "accept").mockImplementationOnce(() => { throw new Error("disk full"); });
  expect(() => failed.receive({ ...event, eventId: "e2", messageId: "om_two" })).toThrow("disk full");
  await failed.close();
});

it.each(["telegram", "feishu", "weixin"])("%s retains output until actual delivery and quarantines uncertain writes", async channel => {
  const journal = journalFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deliver = vi.fn(async (event: OutputEvent) => { if (event.target.conversationId === "slow") await gate; else throw new Error("response lost"); });
  const surface: SurfaceAdapter = { surface: channel, accountId: "account", interactions: {} as SurfaceAdapter["interactions"],
    output: { handle: vi.fn(), deliver }, start: async () => {}, stop: async () => {}, deliverConfigurationChange: async () => {} };
  const output = new EventBus<OutputEvent>(logger);
  const manager = new SurfaceManager([surface], output, logger, undefined, { journal, canDeliver: () => true });
  await manager.start();
  const event = (chat: string): OutputEvent => ({ type: "text.completed", target: { surface: channel, accountId: "account", conversationId: chat }, threadId: "thread", turnId: "turn", itemId: "item", text: "private output", phase: "final_answer" });
  try {
    journal.fail(); // Existing tasks must still hand off output while ordinary input is paused.
    output.publish(event("slow"), true);
    output.publish(event("failed"), true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(journal.usage().records).toBe(2);
    await vi.waitFor(() => expect(journal.usage().uncertain).toBe(1));
    output.publish(event("failed"), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(deliver).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(journal.usage().records).toBe(2));
    expect(journal.inspect().map(record => record.state).sort()).toEqual(["pending", "uncertain"]);
  } finally { release(); await manager.stop(); await output.close(); }
});

it("rechecks current authorization before replay and keeps refused output unresolved", async () => {
  const journal = journalFixture();
  const deliver = vi.fn(async () => {});
  const surface: SurfaceAdapter = { surface: "telegram", accountId: "account", interactions: {} as SurfaceAdapter["interactions"],
    output: { handle: vi.fn(), deliver }, start: async () => {}, stop: async () => {}, deliverConfigurationChange: async () => {} };
  const output = new EventBus<OutputEvent>(logger);
  const manager = new SurfaceManager([surface], output, logger, undefined, { journal, canDeliver: () => false });
  output.publish({ type: "text.completed", target: { surface: "telegram", accountId: "account", conversationId: "previous-owner" },
    threadId: "thread", turnId: "turn", itemId: "reply", text: "private reply", phase: "final_answer" }, true);
  expect(journal.usage().records).toBe(1);
  try {
    await manager.start();
    await vi.waitFor(() => expect(journal.usage().uncertain).toBe(1));
    expect(deliver).not.toHaveBeenCalled();
  } finally { await manager.stop(); await output.close(); }
});

it.each([false, true])("Feishu validation waits for its reply and only quarantines failed delivery (%s)", async fails => {
  const { FeishuConversationAdapter, message, imagePort } = await import("./feishu-adapter-test-fixture.js");
  const { FeishuOutbox } = await import("../src/surfaces/feishu/index.js");
  const { DurableInputQueue } = await import("../src/surfaces/durable-input-queue.js");
  const journal = journalFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = vi.fn(async () => { await gate; if (fails) throw new Error("network failed"); });
  const outbox = new FeishuOutbox(message.target.accountId, { sendText: send } as unknown as ConstructorParameters<typeof FeishuOutbox>[1], logger);
  const adapter = new FeishuConversationAdapter({}, outbox, imagePort);
  let next = false;
  const queue = new DurableInputQueue<string>({ journal, stream: "input", handle: async value => {
    if (value === "next") { next = true; return; }
    await outbox.trackInput(message.target.conversationId, () => adapter.handle({ ...message, kind: "audio", fileKey: "audio", durationMs: 1000 }));
  }, onUncertain: vi.fn() });
  queue.accept("audio", "chat", "audio"); queue.accept("next", "chat", "next"); queue.start();
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(next).toBe(false);
    expect(journal.inspect().map(row => row.state)).toEqual(["processing", "pending"]);
    release();
    await vi.waitFor(() => expect(fails ? journal.usage().uncertain : Number(next)).toBe(1));
    expect(next).toBe(!fails);
    expect(journal.usage().records).toBe(fails ? 2 : 0);
  } finally { release(); await queue.close(); await adapter.close(); await outbox.close(); }
});

it.each(["audio.unsupported", "revert.result-unknown", "queue.failed"] as const)("TG durable input distinguishes %s after sending its error reply", async code => {
  const { UserFacingError } = await import("../src/conversation-core/index.js");
  const { createTelegramSurfaceFixture, cleanupTelegramSurfaceTestDirectories, telegramChat, telegramUser } = await import("./telegram-surface-test-fixture.js");
  const journal = journalFixture();
  const directories: string[] = [];
  const error = new UserFacingError(code, "private details");
  const fixture = createTelegramSurfaceFixture(directories, async () => { throw error; }, vi.fn(), {}, vi.fn(), vi.fn(), undefined, false, undefined, journal);
  try {
    const handling = fixture.surface.bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: telegramChat(), from: telegramUser(), text: "hello" } });
    if (code === "audio.unsupported") await handling;
    else await expect(handling).rejects.toMatchObject({ error });
    expect(fixture.sentTexts.length).toBeGreaterThan(0);
    expect(fixture.sentTexts.join(" ")).not.toContain("private details");
  } finally { await fixture.surface.stop(); await fixture.output.close(); cleanupTelegramSurfaceTestDirectories(directories); }
});

it("TG keeps the failed confirmation prefix while admitting and deduplicating later controls", async () => {
  const journal = journalFixture();
  const accept = journal.accept.bind(journal);
  let refused = false;
  vi.spyOn(journal, "accept").mockImplementation((record, purpose) => {
    if (!record.control && !refused) { refused = true; throw new Error("temporary admission failure"); }
    return accept(record, purpose);
  });
  const handled: number[] = [], offsets: number[] = [];
  const updates = ["first", "second", "/stop"].map((text, index) => ({ update_id: index + 1, message: { message_id: index + 1, date: 1, chat: { id: 1, type: "private" as const }, text } }));
  const bot = { botInfo: { username: "fixture" }, init: async () => {}, handleUpdate: async (update: { update_id: number }) => { handled.push(update.update_id); }, api: {
    setMyCommands: async () => true,
    getUpdates: async ({ offset }: { offset: number }, signal: AbortSignal) => {
      offsets.push(offset);
      if (offset < 4) return updates.filter(update => update.update_id >= offset);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    },
  } };
  const lifecycle = new TelegramLifecycle(bot as unknown as Bot, logger, undefined, undefined, { journal });
  lifecycle.start();
  try {
    await vi.waitFor(() => expect(handled).toEqual([3, 1, 2]), { timeout: 2000 });
    await vi.waitFor(() => expect(offsets).toContain(4));
    expect(offsets.slice(0, 2)).toEqual([0, 0]);
    expect(journal.usage().records).toBe(0);
  } finally { await lifecycle.stop(); }
});

it("TG bounds slow rejection notifications without blocking authorized input or shutdown", async () => {
  const journal = journalFixture();
  const { telegramUpdateSignal } = await import("../src/surfaces/telegram/lifecycle.js");
  const handled: number[] = [];
  const updates = Array.from({ length: 21 }, (_, index) => ({ update_id: index + 1, message: { message_id: index + 1, date: 1, chat: { id: index + 1, type: "private" as const }, text: index === 20 ? "/stop" : "unauthorized" } }));
  let polls = 0;
  const bot = { botInfo: { username: "fixture" }, init: async () => {}, handleUpdate: async (update: typeof updates[number]) => {
    handled.push(update.update_id);
    if (update.update_id !== 21) await new Promise<void>(resolve => telegramUpdateSignal(update)!.addEventListener("abort", () => resolve(), { once: true }));
  }, api: { setMyCommands: async () => true, getUpdates: async (_params: unknown, signal: AbortSignal) => {
    if (++polls === 1) return updates;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return [];
  } } };
  const lifecycle = new TelegramLifecycle(bot as unknown as Bot, logger, undefined, undefined, { journal, acceptUpdate: update => update.update_id === 21 });
  lifecycle.start();
  try {
    await vi.waitFor(() => expect(handled).toContain(21));
    expect(handled.filter(id => id !== 21)).toHaveLength(8);
    expect(polls).toBe(2);
  } finally { await lifecycle.stop(); }
  expect(journal.usage().records).toBe(0);
});

it.each([false, true])("Feishu recovers an image group and confirms or quarantines it together (failure: %s)", async fails => {
  const journal = journalFixture();
  const single = vi.fn(async () => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const group = vi.fn(async () => { await gate; if (fails) throw new Error("submission unknown"); });
  const options = { journal, accountId: "app", access: { isAllowed: () => true }, handle: single, handleImageBatch: group, handleError: vi.fn(), handleCloseTimeout: vi.fn() };
  const inbox = new FeishuInbox(options);
  for (const id of ["1", "2"]) inbox.receive({ appId: "app", eventId: id, messageId: id, createTime: String(Date.now()), senderType: "user", actorOpenId: "actor", chatType: "p2p", chatId: "chat", messageType: "image", content: JSON.stringify({ image_key: `img${id}` }) });
  await inbox.close();
  const restored = new FeishuInbox(options);
  restored.start();
  try {
    await vi.waitFor(() => expect(group).toHaveBeenCalledOnce());
    expect(single).not.toHaveBeenCalled();
    expect(group.mock.calls[0]).toHaveLength(1);
    expect(journal.inspect().map(row => row.state)).toEqual(["processing", "processing"]);
    release();
    await vi.waitFor(() => expect(journal.usage().records).toBe(fails ? 2 : 0));
    if (fails) await vi.waitFor(() => expect(journal.usage().uncertain).toBe(2));
  } finally { release(); await restored.close(); }
});

it("TG typing network failure does not quarantine durable input or block the next message", async () => {
  const { UserFacingError } = await import("../src/conversation-core/index.js");
  const { DurableInputQueue } = await import("../src/surfaces/durable-input-queue.js");
  const { createTelegramSurfaceFixture, cleanupTelegramSurfaceTestDirectories, telegramChat, telegramUser } = await import("./telegram-surface-test-fixture.js");
  const journal = journalFixture();
  const directories: string[] = [];
  let typingFailed!: () => void;
  const failed = new Promise<void>(resolve => { typingFailed = resolve; });
  const submit = vi.fn(async () => {
    await failed;
    throw new UserFacingError("audio.unsupported", "safe rejection");
  });
  const fixture = createTelegramSurfaceFixture(directories, submit, vi.fn(), {}, vi.fn(), vi.fn(), undefined, false, undefined, journal);
  fixture.surface.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "sendChatAction") {
      typingFailed();
      throw Object.assign(new Error("private network details"), { code: "ECONNRESET" });
    }
    return previous(method, payload, signal);
  });
  const onUncertain = vi.fn();
  const queue = new DurableInputQueue<number>({ journal, stream: "tg-test", onUncertain,
    handle: async id => fixture.surface.bot.handleUpdate({ update_id: id,
      message: { message_id: id, date: 1, chat: telegramChat(), from: telegramUser(), text: "hello" } }),
  });
  try {
    queue.start();
    queue.accept("1", "chat", 1);
    queue.accept("2", "chat", 2);
    await vi.waitFor(() => expect(journal.usage().records).toBe(0), { timeout: 4000 });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(fixture.sentTexts).toHaveLength(2);
  } finally { typingFailed(); await queue.close(); await fixture.surface.stop(); await fixture.output.close(); cleanupTelegramSurfaceTestDirectories(directories); }
});

it.each(["recovery-required", "full", "storage-error"])("TG separates %s admission failures, backs off and preserves controls and offset", async reason => {
  const { DeliveryJournalError } = await import("../src/surfaces/index.js");
  vi.useFakeTimers();
  const journal = journalFixture();
  const accept = journal.accept.bind(journal);
  let blocked = true;
  vi.spyOn(journal, "accept").mockImplementation((input, purpose) => {
    if (blocked && !input.control) throw reason === "storage-error" ? new Error("secret path") : new DeliveryJournalError(reason as "full" | "recovery-required");
    return accept(input, purpose);
  });
  const entries: Array<Record<string, unknown>> = [];
  const log = pino({ level: "info" }, { write: value => entries.push(JSON.parse(value)) });
  const offsets: number[] = [];
  const handled: number[] = [];
  const updates = [1, 2].map(id => ({ update_id: id, message: { message_id: id, date: 1,
    chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "User" }, text: id === 2 ? "/stop" : "secret body" } }));
  const bot = { botInfo: { username: "test_bot" }, init: async () => {},
    handleUpdate: async (update: { update_id: number }) => { handled.push(update.update_id); },
    api: { setMyCommands: async () => true, getUpdates: async ({ offset }: { offset: number }, signal: AbortSignal) => {
      offsets.push(offset);
      if (offset < 3) return updates;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    } },
  };
  const fatal = vi.fn();
  const lifecycle = new TelegramLifecycle(bot as unknown as Bot, log, undefined, fatal, { journal });
  try {
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(offsets.length).toBeLessThanOrEqual(8);
    expect(new Set(offsets)).toEqual(new Set([0]));
    expect(handled).toEqual([2]);
    expect(fatal).not.toHaveBeenCalled();
    const warnings = entries.filter(entry => entry.level === 40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ phase: "admission", reason, attempt: 1, retryAfterMs: 1000 });
    expect(JSON.stringify(entries)).not.toMatch(/secret|Long Polling 请求失败/);
    blocked = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handled).toEqual([2, 1]);
    expect(offsets.at(-1)).toBe(3);
    expect(entries.some(entry => entry.msg === "Telegram 消息接纳已恢复")).toBe(true);
  } finally { await lifecycle.stop(); vi.useRealTimers(); }
});
