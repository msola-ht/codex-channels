import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Api, InputFile } from "grammy";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import { DeliveryCoordinator, DeliveryJournal, defaultDeliveryLimits } from "../src/delivery/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import { PersistentSurfaceOutput } from "../src/bootstrap/persistent-surface-output.js";
import { EventBus } from "../src/event-bus/index.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { FeishuOutbox } from "../src/surfaces/feishu/outbox.js";
import { encodeFeishuPostContent } from "../src/surfaces/feishu/message-content.js";
import { FeishuMessageError } from "../src/surfaces/feishu/message-error.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";
import { WeixinOutbox, WeixinReplyContextStore, maximumWeixinOutboundFileBytes } from "../src/surfaces/weixin/index.js";
import { decodePersistentOutput, snapshotPersistentOutput, withPersistentOutputImage, type SurfaceAdapter } from "../src/surfaces/index.js";

const directories: string[] = [];
const logger = pino({ level: "silent" });
const workerUrl = new URL("../dist/delivery/worker.js", import.meta.url);
const fixture = () => { const path = mkdtempSync(join(tmpdir(), "codexc-delivery-")); directories.push(path); return path; };
const submission = (id: string, conversation = "chat") => ({ id, account: "account", conversation, payload: `PRIVATE RESULT ${id}` });
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("encrypted delivery journal", () => {
  it("retains pending results and fences uncertain sends across restart without exposing plaintext", () => {
    const directory = fixture();
    let store = new SqliteDeliveryJournal(directory);
    store.execute({ type: "submit", value: submission("first") });
    store.execute({ type: "submit", value: submission("second") });
    store.execute({ type: "submit", value: submission("independent", "other") });
    store.execute({ type: "state", id: "first", from: "pending", to: "sending" });
    store.execute({ type: "checkpoint", id: "first", value: { operation: "send", state: "started" } });
    store.close();
    expect(readFileSync(join(directory, "outbox.sqlite3")).includes(Buffer.from("PRIVATE RESULT"))).toBe(false);
    store = new SqliteDeliveryJournal(directory);
    try {
      expect(store.execute({ type: "summary" })).toMatchObject({ records: 3, uncertain: 1 });
      expect(store.execute({ type: "next", excluded: [] })).toMatchObject({ id: "independent" });
      expect(store.execute({ type: "acknowledge", id: "first" })).toBe(false);
    } finally { store.close(); }
  });

  it("rejects capacity overflow transactionally without expiring accepted results", () => {
    const store = new SqliteDeliveryJournal(fixture(), { ...defaultDeliveryLimits, records: 1 });
    try {
      store.execute({ type: "submit", value: submission("first") });
      expect(() => store.execute({ type: "submit", value: submission("second") })).toThrow("capacity");
      expect(store.execute({ type: "summary" })).toMatchObject({ records: 1, pending: 1 });
      expect(store.execute({ type: "next", excluded: [] })).toMatchObject({ payload: "PRIVATE RESULT first" });
    } finally { store.close(); }
  });

  it("isolates an exhausted account quota while retaining capacity for another account", () => {
    const store = new SqliteDeliveryJournal(fixture(), { ...defaultDeliveryLimits, accountRecords: 1 });
    try {
      store.execute({ type: "submit", value: submission("first") });
      expect(() => store.execute({ type: "submit", value: submission("second") })).toThrow("account-capacity");
      store.execute({ type: "submit", value: { ...submission("other", "other-chat"), account: "other-account" } });
      expect(store.execute({ type: "summary" })).toMatchObject({ records: 2, pending: 2 });
    } finally { store.close(); }
  });

  it("retains committed results when SQLite itself exhausts its page budget", () => {
    const store = new SqliteDeliveryJournal(fixture());
    try {
      store.execute({ type: "submit", value: submission("kept") });
      const database = Reflect.get(store, "database") as DatabaseSync;
      database.exec("PRAGMA max_page_count=20");
      expect(() => store.execute({ type: "submit", value: { ...submission("rejected"), payload: "x".repeat(512 * 1024) } })).toThrow("storage");
      expect(store.execute({ type: "summary" })).toMatchObject({ records: 1 });
      expect(store.execute({ type: "next", excluded: [] })).toMatchObject({ id: "kept", payload: "PRIVATE RESULT kept" });
    } finally { store.close(); }
  });

  it("fails closed on ciphertext tampering and unsupported schema without replacing the database", () => {
    const directory = fixture();
    const store = new SqliteDeliveryJournal(directory);
    store.execute({ type: "submit", value: submission("first") });
    store.close();
    const database = new DatabaseSync(join(directory, "outbox.sqlite3"));
    database.exec("UPDATE deliveries SET payload=zeroblob(length(payload))");
    database.close();
    expect(() => new SqliteDeliveryJournal(directory)).toThrow("storage");
    const check = new DatabaseSync(join(directory, "outbox.sqlite3"));
    expect(check.prepare("SELECT COUNT(*) AS count FROM deliveries").get()?.count).toBe(1);
    check.exec("PRAGMA user_version=99");
    check.close();
    expect(() => new SqliteDeliveryJournal(directory)).toThrow("storage");
  });

  it("uses the real bounded Worker transport for acceptance and acknowledgement", async () => {
    const journal = new DeliveryJournal(fixture(), { workerUrl });
    try {
      await journal.ready;
      await journal.submit(submission("first"));
      expect(await journal.next()).toMatchObject({ id: "first", payload: "PRIVATE RESULT first" });
      expect(await journal.transition("first", "pending", "sending")).toBe(true);
      await journal.checkpoint("first", { operation: "send", state: "confirmed", messageId: "message" });
      expect(await journal.acknowledge("first")).toBe(true);
      expect(await journal.summary()).toMatchObject({ records: 0 });
    } finally { await journal.close(); }
  });

  it("recovers a committed result after process death and releases the exclusive writer lock", async () => {
    const directory = fixture();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { SqliteDeliveryJournal } from ${JSON.stringify(new URL("../dist/delivery/sqlite-journal.js", import.meta.url).href)};
      const store = new SqliteDeliveryJournal(process.argv[1]);
      store.execute({ type: "submit", value: { id: "crashed", account: "account", conversation: "chat", payload: "result" } });
      store.execute({ type: "state", id: "crashed", from: "pending", to: "sending" });
      process.exit(0);
    `, directory], { timeout: 10_000 });
    expect(child.status).toBe(0);
    const journal = new DeliveryJournal(directory, { workerUrl });
    try {
      await journal.ready;
      expect(await journal.summary()).toMatchObject({ uncertain: 1 });
      expect(await journal.next()).toBeNull();
      expect(await journal.resolve("crashed", "retry")).toBe(true);
      expect(await journal.next()).toMatchObject({ id: "crashed", attempt: 1 });
      expect(await journal.resolve("crashed", "confirm")).toBe(false);
    } finally { await journal.close(); }
  });

  it("rejects a second writer and restores a stopped backup only with the original key", () => {
    const source = fixture();
    const restored = fixture();
    const store = new SqliteDeliveryJournal(source);
    store.execute({ type: "submit", value: submission("backup") });
    expect(() => new SqliteDeliveryJournal(source)).toThrow("conflict");
    store.close();
    copyFileSync(join(source, "outbox.sqlite3"), join(restored, "outbox.sqlite3"));
    expect(() => new SqliteDeliveryJournal(restored)).toThrow("storage");
    copyFileSync(join(source, "payload.key"), join(restored, "payload.key"));
    const recovered = new SqliteDeliveryJournal(restored);
    expect(recovered.execute({ type: "next", excluded: [] })).toMatchObject({ payload: "PRIVATE RESULT backup" });
    recovered.close();
    unlinkSync(join(restored, "payload.key"));
    expect(() => new SqliteDeliveryJournal(restored)).toThrow("storage");
  });
});

it("restores a generated image from encrypted payload after its original path disappears", async () => {
  const directory = fixture();
  const path = join(directory, "original.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  writeFileSync(path, bytes);
  const event: OutputEvent = {
    type: "operation.updated", target: { surface: "telegram", accountId: "default", conversationId: "chat" },
    threadId: "thread", turnId: "turn",
    operation: { itemId: "image", kind: "imageGeneration", status: "completed", detail: "generated", imagePath: path },
  };
  const payload = await snapshotPersistentOutput(event, "owner");
  let store = new SqliteDeliveryJournal(directory);
  store.execute({ type: "submit", value: { ...submission("image"), payload: JSON.stringify(payload) } });
  store.close();
  unlinkSync(path);
  store = new SqliteDeliveryJournal(directory);
  let restoredPath: string | undefined;
  try {
    const record = store.execute({ type: "next", excluded: [] });
    if (!record || typeof record !== "object" || !("payload" in record)) throw new Error("missing image record");
    await withPersistentOutputImage(decodePersistentOutput(record.payload), directory, async (restored) => {
      if (restored.type !== "operation.updated") throw new Error("wrong restored event");
      restoredPath = restored.operation.imagePath;
      expect(restoredPath).not.toBe(path);
      expect(readFileSync(restoredPath!)).toEqual(bytes);
    });
    expect(existsSync(restoredPath!)).toBe(false);
    expect(store.execute({ type: "summary" })).toMatchObject({ records: 1 });
  } finally { store.close(); }
});

it("bounds waiting on an unresponsive Worker and releases pending acceptance promises", async () => {
  const journal = new DeliveryJournal(fixture(), {
    workerUrl: new URL(`data:text/javascript,${encodeURIComponent('import { parentPort } from "node:worker_threads"; parentPort.postMessage({ id: 0, ok: true, result: null }); parentPort.on("message", ({ id, command }) => { if (command.type === "summary") parentPort.postMessage({ id, ok: true, result: { records: 0 } }); });')}`),
  });
  try {
    await journal.ready;
    vi.useFakeTimers();
    const payload = "x".repeat(defaultDeliveryLimits.recordBytes);
    const first = journal.submit({ ...submission("waiting-1"), payload });
    const second = journal.submit({ ...submission("waiting-2"), payload });
    const rejected = Promise.all([expect(first).rejects.toThrow("storage"), expect(second).rejects.toThrow("storage")]);
    await expect(journal.submit(submission("overflow"))).rejects.toThrow("mailbox-full");
    await expect(journal.summary()).resolves.toMatchObject({ records: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
  } finally { vi.useRealTimers(); await journal.close(); }
});

it("rechecks authorization before each fragment and retains a partly delivered result after revocation", async () => {
  const directory = fixture();
  const target = { surface: "telegram" as const, accountId: "default", conversationId: "chat" };
  let allowed = true;
  let sends = 0;
  const faults: string[] = [];
  const output = new PersistentSurfaceOutput({
    directory, workerUrl, owner: () => "owner", authorized: () => allowed,
    accounts: () => [JSON.stringify([target.surface, target.accountId])],
    deliver: async (_event, _signal, checkpoint) => {
      await checkpoint({ operation: "send", state: "started" });
      sends++;
      await checkpoint({ operation: "send", state: "confirmed", messageId: "first-fragment" });
      allowed = false;
      await checkpoint({ operation: "send", state: "started" });
      sends++;
    }, fault: (code) => { faults.push(code); },
  });
  try {
    await output.start();
    output.accept({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", text: "two fragments", phase: "final_answer" });
    await vi.waitFor(() => expect(faults).toContain("delivery-uncertain"));
    expect(sends).toBe(1);
  } finally { await output.close(); }
  const journal = new DeliveryJournal(directory, { workerUrl });
  try {
    await journal.ready;
    expect(await journal.list()).toEqual([expect.objectContaining({ state: "uncertain", progress: [
      { operation: "send", state: "started" }, { operation: "send", state: "confirmed", messageId: "first-fragment" }, { operation: "send", state: "started" },
    ] })]);
  } finally { await journal.close(); }
});

it("fences an ambiguous send and revoked ownership without blocking another Conversation", async () => {
  const journal = new DeliveryJournal(fixture(), { workerUrl });
  const delivered: string[] = [];
  const faults: string[] = [];
  const coordinator = new DeliveryCoordinator(journal, {
    accounts: () => ["account"], authorized: (record) => record.id !== "revoked",
    deliver: async (record) => {
      delivered.push(record.id);
      await journal.checkpoint(record.id, { operation: "send", state: "started" });
      if (record.id === "ambiguous") throw new Error("network outcome unknown");
      await journal.checkpoint(record.id, { operation: "send", state: "confirmed" });
    }, fault: (code) => { faults.push(code); },
  });
  try {
    await coordinator.start();
    coordinator.submit(submission("ambiguous"));
    coordinator.submit(submission("same-chat"));
    coordinator.submit(submission("revoked", "revoked-chat"));
    coordinator.submit(submission("independent", "other-chat"));
    await vi.waitFor(async () => expect(await journal.summary()).toMatchObject({ uncertain: 1, blocked: 1, pending: 1, sending: 0 }));
    expect(delivered).toEqual(["ambiguous", "independent"]);
    expect(faults).toEqual(expect.arrayContaining(["delivery-uncertain", "authorization-changed"]));
    expect(await journal.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ambiguous", progress: [{ operation: "send", state: "started" }] })]));
  } finally { await coordinator.close(); }
});

it("holds execution admission between the 80% and 60% account watermarks while output drains", async () => {
  const directory = fixture();
  const store = new SqliteDeliveryJournal(directory);
  const payload = "x".repeat(defaultDeliveryLimits.recordBytes - 100);
  for (let index = 0; index < 14; index++) store.execute({ type: "submit", value: { ...submission(String(index)), payload } });
  store.close();
  let enabled = false;
  let release: (() => void) | undefined;
  let attempts = 0;
  const journal = new DeliveryJournal(directory, { workerUrl });
  const coordinator = new DeliveryCoordinator(journal, {
    accounts: () => enabled ? ["account"] : [], authorized: () => true, concurrency: 1,
    deliver: async () => { attempts++; await new Promise<void>((resolve) => { release = resolve; }); },
    fault: () => {},
  });
  try {
    await coordinator.start();
    expect(coordinator.acceptsExecution("account")).toBe(false);
    expect(coordinator.acceptsExecution("other")).toBe(true);
    enabled = true;
    coordinator.wake();
    for (let drained = 1; drained <= 5; drained++) {
      await vi.waitFor(() => expect(attempts).toBe(drained));
      release!();
      await vi.waitFor(async () => expect((await journal.summary()).records).toBe(14 - drained));
      if (drained === 3) expect(coordinator.acceptsExecution("account")).toBe(false);
    }
    expect(coordinator.acceptsExecution("account")).toBe(true);
  } finally { enabled = false; release?.(); await coordinator.close(); }
}, 15_000);

it("retains an unavailable channel's output, restarts, delivers through the actual Outbox, then acknowledges", async () => {
  const directory = fixture();
  const target = { surface: "telegram" as const, accountId: "default", conversationId: "chat" };
  const sent: string[] = [];
  const faults: string[] = [];
  const api = { sendMessage: async (_chat: string, text: string) => { sent.push(text); return { message_id: sent.length }; } } as unknown as Api;
  const create = (available: boolean) => {
    const output = new EventBus<OutputEvent>(logger);
    const outbox = new TelegramOutbox(api, logger);
    const surface: SurfaceAdapter = {
      surface: "telegram", accountId: "default", output: outbox,
      interactions: { request: async () => ({ type: "approval", approved: false }) },
      start: async () => { if (!available) throw new Error("offline"); }, stop: () => outbox.close(),
      configurationChanged: () => {}, deliverConfigurationChange: async () => {},
    };
    const manager = new SurfaceManager([surface], output, logger, undefined, {
      retryDelaysMs: [60_000],
      persistence: { directory, workerUrl, owner: () => "actor", authorized: (_event, owner) => owner === "actor", fault: (code) => { faults.push(code); } },
    });
    return { output, manager };
  };
  const first = create(false);
  await first.manager.start();
  first.output.publish({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", text: "durable answer", phase: "final_answer" }, true);
  for (const status of ["running", "completed"] as const) {
    first.output.publish({ type: "operation.updated", target, threadId: "thread", turnId: "turn", operation: { itemId: "compaction", kind: "contextCompaction", status } }, true);
  }
  await first.manager.stop();
  await first.output.close();
  expect(sent).toEqual([]);
  const pending = new DeliveryJournal(directory, { workerUrl });
  await pending.ready;
  expect(await pending.summary()).toMatchObject({ records: 3, pending: 3 });
  await pending.close();
  const second = create(true);
  try {
    await second.manager.start();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await vi.waitFor(() => {
      const database = new DatabaseSync(join(directory, "outbox.sqlite3"), { readOnly: true });
      try { expect(database.prepare("SELECT COUNT(*) AS count FROM deliveries").get()?.count).toBe(0); }
      finally { database.close(); }
    });
    expect(sent[0]).toContain("durable answer");
    expect(sent.slice(1)).toEqual(["开始压缩上下文…", "上下文压缩已完成。"]);
    expect(faults).toEqual([]);
  } finally {
    await second.manager.stop();
    await second.output.close();
  }
});


it("retains compaction start behind an online channel's unconfirmed answer", async () => {
  const directory = fixture();
  const target = { surface: "telegram" as const, accountId: "default", conversationId: "chat" };
  const sent: string[] = [];
  const faults: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const api = { sendMessage: async (_chat: string, text: string) => {
    sent.push(text);
    if (sent.length === 1) await blocked;
    return { message_id: sent.length };
  } } as unknown as Api;
  const output = new EventBus<OutputEvent>(logger);
  const outbox = new TelegramOutbox(api, logger, undefined, { operationUpdateDisplay: "hidden" });
  const surface: SurfaceAdapter = {
    surface: "telegram", accountId: "default", output: outbox,
    interactions: { request: async () => ({ type: "approval", approved: false }) },
    start: async () => {}, stop: () => outbox.close(),
    configurationChanged: () => {}, deliverConfigurationChange: async () => {},
  };
  const manager = new SurfaceManager([surface], output, logger, undefined, {
    persistence: { directory, workerUrl, owner: () => "actor", authorized: () => true, fault: (code) => { faults.push(code); } },
  });
  const countRecords = (): number => {
    const database = new DatabaseSync(join(directory, "outbox.sqlite3"), { readOnly: true });
    try { return Number(database.prepare("SELECT COUNT(*) AS count FROM deliveries").get()?.count); }
    finally { database.close(); }
  };
  try {
    await manager.start();
    output.publish({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "answer", text: "prior answer", phase: "final_answer" }, true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    for (const status of ["running", "completed"] as const) {
      output.publish({ type: "operation.updated", target, threadId: "thread", turnId: "turn", operation: { itemId: "compaction", kind: "contextCompaction", status } }, true);
    }
    await vi.waitFor(() => expect(countRecords()).toBe(3));
    expect(sent).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(countRecords()).toBe(0));
    expect(sent.slice(1)).toEqual(["开始压缩上下文…", "上下文压缩已完成。"]);
    expect(faults).toEqual([]);
  } finally {
    release();
    await manager.stop();
    await output.close();
  }
});

it.each([false, true])("keeps the full durable Telegram result until its document is confirmed (failure=%s)", async (failure) => {
  const directory = fixture();
  const text = "a".repeat(1_100_000) + "END-OF-RESULT";
  let document: string | undefined;
  let finish!: () => void;
  const pending = new Promise<void>((resolve, reject) => {
    finish = () => failure ? reject(new Error("ambiguous document send")) : resolve();
  });
  const outbox = new TelegramOutbox({
    sendMessage: async () => ({ message_id: 1 }),
    sendDocument: async (_chat: string, file: InputFile) => {
      const raw = await file.toRaw();
      if (!(raw instanceof Uint8Array)) throw new Error("expected buffered fixture");
      document = Buffer.from(raw).toString("utf8");
      await pending;
      return { message_id: 2 };
    },
  } as unknown as Api, logger);
  const journal = new DeliveryJournal(directory, { workerUrl });
  const coordinator = new DeliveryCoordinator(journal, {
    accounts: () => ["account"], authorized: () => true, fault: () => {},
    deliver: (record, signal) => outbox.deliver(JSON.parse(record.payload) as OutputEvent, signal,
      async (checkpoint) => { await journal.checkpoint(record.id, checkpoint); }),
  });
  const event: OutputEvent = { type: "text.completed", target: { surface: "telegram", accountId: "default", conversationId: "chat" },
    threadId: "thread", turnId: "turn", itemId: "item", phase: "final_answer", text };
  try {
    await coordinator.start();
    await coordinator.submit({ ...submission("full-result"), payload: JSON.stringify(event) });
    await vi.waitFor(() => expect(document).toBe(text));
    expect(await journal.summary()).toMatchObject({ records: 1, sending: 1 });
    finish();
    await vi.waitFor(async () => expect(await journal.summary()).toMatchObject(failure ? { records: 1, uncertain: 1 } : { records: 0 }));
  } finally { finish(); await coordinator.close(); await outbox.close(); }
  const reopened = new SqliteDeliveryJournal(directory);
  try {
    expect(reopened.execute({ type: "summary" })).toMatchObject({ records: failure ? 1 : 0 });
    if (failure) {
      reopened.execute({ type: "resolve", id: "full-result", action: "retry" });
      expect(reopened.execute({ type: "next", excluded: [] })).toMatchObject({ payload: JSON.stringify(event) });
    }
  } finally { reopened.close(); }
});


it.each(["confirmed", "boundary", "failed", "unavailable", "oversized"] as const)("preserves complete Weixin results and Conversation ordering across restart (%s)", async (mode) => {
  const directory = fixture();
  const target = { surface: "weixin" as const, accountId: "account-fixture@im.bot", conversationId: "actor-fixture@im.wechat" };
  const marker = "END-OF-RESULT";
  const text = mode === "boundary" ? "x".repeat(maximumWeixinOutboundFileBytes - marker.length) + marker
    : "测".repeat(mode === "oversized" ? Math.ceil(maximumWeixinOutboundFileBytes / 3) : 20_001) + marker;
  const event: OutputEvent = { type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", phase: "final_answer", text };
  const payload = JSON.stringify(event);
  const success = mode === "confirmed" || mode === "boundary";
  const hasFile = mode !== "unavailable" && mode !== "oversized";
  const sent: string[] = [];
  const faults: string[] = [];
  let fileText: string | undefined;
  let finishFile!: () => void;
  const confirmation = new Promise<void>((resolve) => { finishFile = resolve; });
  const createOutbox = () => new WeixinOutbox(target.accountId, {
    sendText: async ({ text: value }) => { sent.push(value); },
  }, new WeixinReplyContextStore(target.accountId), { isAllowed: () => true }, logger, {
    ...(mode === "unavailable" ? {} : { fileClient: { sendFile: async ({ file }: { file: Buffer }) => {
      fileText = file.toString("utf8");
      await confirmation;
      if (mode === "failed") throw new Error("ambiguous file confirmation");
    } } }),
  });
  const createCoordinator = (journal: DeliveryJournal, outbox: WeixinOutbox) => new DeliveryCoordinator(journal, {
    accounts: () => ["account"], authorized: () => true, fault: (code) => { faults.push(code); },
    deliver: (record, signal) => outbox.deliver(JSON.parse(record.payload) as OutputEvent, signal,
      async (checkpoint) => { await journal.checkpoint(record.id, checkpoint); }),
  });
  const journal = new DeliveryJournal(directory, { workerUrl });
  const outbox = createOutbox();
  const coordinator = createCoordinator(journal, outbox);
  const entry = (id: string, conversation = "chat") => ({ ...submission(id, conversation), payload: JSON.stringify({ ...event,
    target: { ...target, conversationId: conversation === "chat" ? target.conversationId : "other-fixture@im.wechat" },
    itemId: id, text: id,
  }) });
  try {
    await journal.ready;
    await journal.submit({ ...submission("full-result"), payload });
    await journal.submit(entry("same-conversation-next"));
    await journal.submit(entry("independent", "other"));
    await coordinator.start();
    if (hasFile) {
      await vi.waitFor(() => expect(fileText).toBe(text));
      expect(await journal.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "full-result", state: "sending" }),
        expect.objectContaining({ id: "same-conversation-next", state: "pending" }),
      ]));
      expect(sent).not.toContain("same-conversation-next");
      finishFile();
    }
    await vi.waitFor(async () => expect(await journal.summary()).toMatchObject(success
      ? { records: 0 } : { records: 2, uncertain: 1, pending: 1, sending: 0 }));
    expect(sent).toContain("independent");
    expect(sent.includes("same-conversation-next")).toBe(success);
    expect(faults).toEqual(success ? [] : ["delivery-uncertain"]);
    if (!hasFile) {
      expect(fileText).toBeUndefined();
      expect(sent.join("")).not.toContain(marker);
      expect(sent.join("")).toContain("内容过长，已截断");
    }
  } finally { finishFile(); await coordinator.close(); await outbox.close(); }

  const beforeRestart = sent.length;
  const recovered = new DeliveryJournal(directory, { workerUrl });
  const recoveredOutbox = createOutbox();
  const recovery = createCoordinator(recovered, recoveredOutbox);
  try {
    await recovered.ready;
    await recovered.submit(entry("after-restart-independent", "other"));
    await recovery.start();
    await vi.waitFor(() => expect(sent.slice(beforeRestart)).toEqual(["after-restart-independent"]));
    await vi.waitFor(async () => expect(await recovered.summary()).toMatchObject(success
      ? { records: 0 } : { records: 2, uncertain: 1, pending: 1, sending: 0 }));
  } finally { await recovery.close(); await recoveredOutbox.close(); }
  if (!success) {
    const stored = new SqliteDeliveryJournal(directory);
    try {
      expect(stored.execute({ type: "next", excluded: [] })).toBeNull();
      stored.execute({ type: "resolve", id: "full-result", action: "retry" });
      expect(stored.execute({ type: "next", excluded: [] })).toMatchObject({ id: "full-result", payload });
    } finally { stored.close(); }
  }
});

it.each(["confirmed", "failed", "unavailable", "stream", "stream-commentary", "stream-unavailable", "static-commentary"] as const)("requires a complete Feishu file before deleting a truncated preview (%s)", async (mode) => {
  const directory = fixture();
  const streaming = mode.startsWith("stream");
  const unavailable = mode.includes("unavailable");
  const previews: string[] = [];
  const text = "\u{20000}".repeat(streaming || mode === "static-commentary" ? 30_000 : 24_990) + "END-OF-RESULT";
  let fileText: string | undefined;
  let releaseFile!: () => void;
  const fileConfirmation = new Promise<void>((resolve) => { releaseFile = resolve; });
  const sendFile = vi.fn(async (_chat: string, _name: string, file: Buffer) => {
    fileText = file.toString("utf8");
    await fileConfirmation;
    if (mode === "failed") throw new Error("ambiguous file send");
  });
  const outbox = new FeishuOutbox("default", {
    sendText: async () => {}, sendPost: async (_chat, value) => { previews.push(value); },
    sendMarkdownCard: async () => { throw new FeishuMessageError("card-create-failed", "fixture rejection"); },
    sendCard: async () => "message", updateCard: async () => {},
    createStreamingCard: async () => ({ cardId: "card", messageId: "message" }),
    updateStreamingCard: async () => {}, finishStreamingCard: async (_id, _sequence, value) => { if (value) previews.push(value); },
    ...(unavailable ? {} : { sendFile }),
  }, logger);
  const target = { surface: "feishu" as const, accountId: "default", conversationId: "chat" };
  if (streaming) {
    outbox.handle({ type: "text.delta", target, threadId: "thread", turnId: "turn", itemId: "item", text: "start", phase: "final_answer" });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const journal = new DeliveryJournal(directory, { workerUrl });
  const coordinator = new DeliveryCoordinator(journal, {
    accounts: () => ["account"], authorized: () => true, fault: () => {},
    deliver: (record, signal) => outbox.deliver(JSON.parse(record.payload) as OutputEvent, signal,
      async (checkpoint) => { await journal.checkpoint(record.id, checkpoint); }),
  });
  const event: OutputEvent = { type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", phase: mode.endsWith("commentary") ? "commentary" : "final_answer", text };
  const retained = mode === "failed" || unavailable;
  try {
    await coordinator.start();
    await coordinator.submit({ ...submission("full-feishu"), payload: JSON.stringify(event) });
    if (!unavailable) {
      await vi.waitFor(() => expect(fileText).toBe(text));
      expect(await journal.summary()).toMatchObject({ records: 1, sending: 1 });
      releaseFile();
    }
    await vi.waitFor(async () => expect(await journal.summary()).toMatchObject(retained ? { records: 1, uncertain: 1 } : { records: 0 }));
    if (!unavailable) { expect(fileText).toBe(text); expect(sendFile).toHaveBeenCalledOnce(); }
    expect(previews.join("\n")).toContain(unavailable ? "内容过长，已截断" : "内容预览，完整回复见附件");
    if (unavailable) expect(previews.join("\n")).not.toContain("完整回复见附件");
    if (mode === "static-commentary") expect([...previews.join("")].length).toBeLessThanOrEqual(1_200);
  } finally { releaseFile(); await coordinator.close(); await outbox.close(); }
  const reopened = new SqliteDeliveryJournal(directory);
  try {
    expect(reopened.execute({ type: "summary" })).toMatchObject({ records: retained ? 1 : 0 });
    if (retained) {
      reopened.execute({ type: "resolve", id: "full-feishu", action: "retry" });
      expect(reopened.execute({ type: "next", excluded: [] })).toMatchObject({ payload: JSON.stringify(event) });
    }
  } finally { reopened.close(); }
});

it.each(["confirmed", "failed", "cancelled", "post-failed"] as const)("recovers a failed Feishu reply stream through bounded Posts and durable file confirmation (%s)", async (outcome) => {
  const directory = fixture();
  const target = { surface: "feishu" as const, accountId: "default", conversationId: "chat" };
  const text = "start" + "\u{20000}".repeat(30_000) + "END-OF-RESULT";
  const posts: Array<{ reply: boolean; bytes: number }> = [];
  const abort = new AbortController();
  let releaseFile!: () => void;
  const fileConfirmation = new Promise<void>((resolve) => { releaseFile = resolve; });
  const sendFile = vi.fn(async (_chat: string, _name: string, file: Buffer) => {
    expect(file.toString("utf8")).toBe(text);
    await fileConfirmation;
    if (outcome === "failed") throw new Error("ambiguous file send");
  });
  const post = (reply: boolean) => async (_id: string, markdown: string) => {
    const bytes = Buffer.byteLength(encodeFeishuPostContent(markdown));
    posts.push({ reply, bytes });
    if (outcome === "post-failed") throw new Error("ambiguous Post send");
    if (bytes > 20_000) throw new FeishuMessageError("send-failed", "fixture oversized Post rejection");
  };
  const createStreamingCard = vi.fn(async () => { throw new FeishuMessageError("card-create-failed", "fixture safe rejection"); });
  const later = vi.fn(async () => "later-message");
  const outbox = new FeishuOutbox("default", {
    sendText: async () => {}, sendPost: post(false), replyPost: post(true),
    sendMarkdownCard: later, sendCard: async () => "message", updateCard: async () => {},
    createStreamingCard, updateStreamingCard: async () => {}, finishStreamingCard: async () => {}, sendFile,
  }, logger);
  const event: OutputEvent = { type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", phase: "final_answer", text };
  const journal = new DeliveryJournal(directory, { workerUrl });
  const coordinator = new DeliveryCoordinator(journal, {
    accounts: () => ["account"], authorized: () => true, fault: () => {},
    deliver: (record, signal) => outbox.deliver(JSON.parse(record.payload) as OutputEvent, AbortSignal.any([signal, abort.signal]),
      async (checkpoint) => { await journal.checkpoint(record.id, checkpoint); }),
  });
  try {
    outbox.prepareTurnReplyTarget("chat", "source-message");
    outbox.handle({ type: "turn.started", target, threadId: "thread", turnId: "turn" });
    outbox.handle({ ...event, type: "text.delta", text: "start" });
    await vi.waitFor(() => expect(createStreamingCard).toHaveBeenCalledOnce());
    later.mockClear();
    await coordinator.start();
    await coordinator.submit({ ...submission("reply-result"), payload: JSON.stringify(event) });
    await coordinator.submit({ ...submission("later-result"), payload: JSON.stringify({ ...event, itemId: "later", text: "later result" }) });
    if (outcome !== "post-failed") {
      await vi.waitFor(() => expect(sendFile).toHaveBeenCalledOnce());
      expect(await journal.summary()).toMatchObject({ records: 2, sending: 1, pending: 1 });
      expect(later).not.toHaveBeenCalled();
      if (outcome === "cancelled") abort.abort();
    }
    releaseFile();
    await vi.waitFor(async () => expect(await journal.summary()).toMatchObject(outcome === "confirmed"
      ? { records: 0 } : { records: 2, uncertain: 1, pending: 1 }));
    expect(later).toHaveBeenCalledTimes(outcome === "confirmed" ? 1 : 0);
    expect(posts).toHaveLength(outcome === "post-failed" ? 1 : 5);
    expect(posts.filter((value) => value.reply)).toHaveLength(1);
    expect(posts.every((value) => value.bytes <= 20_000)).toBe(true);
    expect(sendFile).toHaveBeenCalledTimes(outcome === "post-failed" ? 0 : 1);
  } finally { releaseFile(); await coordinator.close(); await outbox.close(); }
  const reopened = new SqliteDeliveryJournal(directory);
  try {
    expect(reopened.execute({ type: "summary" })).toMatchObject({ records: outcome === "confirmed" ? 0 : 2 });
    if (outcome !== "confirmed") {
      reopened.execute({ type: "resolve", id: "reply-result", action: "retry" });
      expect(reopened.execute({ type: "next", excluded: [] })).toMatchObject({ payload: JSON.stringify(event) });
    }
  } finally { reopened.close(); }
});
