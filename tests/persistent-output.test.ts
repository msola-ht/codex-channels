import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Api } from "grammy";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import { DeliveryCoordinator, DeliveryJournal, defaultDeliveryLimits } from "../src/delivery/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import { PersistentSurfaceOutput } from "../src/bootstrap/persistent-surface-output.js";
import { EventBus } from "../src/event-bus/index.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";
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
  await first.manager.stop();
  await first.output.close();
  expect(sent).toEqual([]);
  const pending = new DeliveryJournal(directory, { workerUrl });
  await pending.ready;
  expect(await pending.summary()).toMatchObject({ records: 1, pending: 1 });
  await pending.close();
  const second = create(true);
  try {
    await second.manager.start();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.waitFor(() => {
      const database = new DatabaseSync(join(directory, "outbox.sqlite3"), { readOnly: true });
      try { expect(database.prepare("SELECT COUNT(*) AS count FROM deliveries").get()?.count).toBe(0); }
      finally { database.close(); }
    });
    expect(sent[0]).toContain("durable answer");
    expect(faults).toEqual([]);
  } finally {
    await second.manager.stop();
    await second.output.close();
  }
});
