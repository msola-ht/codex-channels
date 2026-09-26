import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryJournal } from "../src/surfaces/delivery-journal.js";
import { DurableInputQueue } from "../src/surfaces/durable-input-queue.js";

const directories: string[] = [];
const journals: DeliveryJournal[] = [];
function fixture(options?: ConstructorParameters<typeof DeliveryJournal>[1]) {
  const directory = mkdtempSync(join(tmpdir(), "delivery-journal-test-"));
  directories.push(directory);
  const journal = new DeliveryJournal(directory, options);
  journals.push(journal);
  return { directory, journal };
}
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable delivery journal", () => {
  it("encrypts pending bodies, persists deduplication and clears successful payloads", () => {
    const { directory, journal } = fixture();
    const input = { id: "message", stream: "input", lane: "private-chat", control: false, payload: { text: "private message content" } };
    expect(journal.accept(input)).toBe(true);
    const [entry] = journal.pending("input");
    expect(journal.read(entry!.id).payload).toEqual(input.payload);
    expect(readFileSync(join(directory, "pending.sqlite")).includes(Buffer.from(input.payload.text))).toBe(false);
    journal.close();
    const reopened = new DeliveryJournal(directory); journals.push(reopened);
    expect(reopened.accept(input)).toBe(false);
    reopened.mark(entry!.id, "processing");
    reopened.mark(entry!.id, "done");
    expect(reopened.usage()).toEqual({ records: 0, bytes: 0, uncertain: 0 });
    expect(reopened.accept(input)).toBe(false);
  });

  it("quarantines interrupted submissions and blocks later ordinary input in that lane", () => {
    const { directory, journal } = fixture();
    for (const id of ["one", "two"]) journal.accept({ id, stream: "input", lane: "chat", control: false, payload: id });
    journal.mark(journal.pending("input")[0]!.id, "processing");
    journal.close();
    const reopened = new DeliveryJournal(directory); journals.push(reopened);
    expect(reopened.recover("input")).toBe(1);
    expect(reopened.pending("input")).toEqual([]);
    reopened.accept({ id: "stop", stream: "input", lane: "chat", control: true, payload: "/stop" });
    expect(reopened.pending("input")).toHaveLength(1);
    expect(reopened.usage().uncertain).toBe(1);
  });

  it("reserves space for controls and rejects overload without claiming admission", () => {
    const { journal } = fixture({ maximumRecords: 3, reservedRecords: 1, maximumBytes: 20_000, reservedBytes: 1_000 });
    const accept = (id: string, control = false) => journal.accept({ id, stream: "input", lane: id, payload: id, control });
    accept("one"); accept("two");
    expect(() => accept("three")).toThrow("已满");
    expect(accept("stop", true)).toBe(true);
    expect(() => accept("another", true)).toThrow("已满");
    expect(journal.pending("input")).toHaveLength(3);
  });

  it("does not open a second owner or an unsupported format", () => {
    const { directory, journal } = fixture();
    expect(() => new DeliveryJournal(directory)).toThrow();
    journal.close();
    const db = new DatabaseSync(join(directory, "pending.sqlite"));
    db.exec("PRAGMA user_version=2"); db.close();
    expect(() => new DeliveryJournal(directory)).toThrow("校验失败");
  });

  it("separates admission from execution, preserves chat order and admits controls", async () => {
    const { journal } = fixture();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new DurableInputQueue<string>({ journal, stream: "input", onUncertain: vi.fn(),
      handle: async value => { seen.push(value); if (value === "slow") await gate; },
    });
    queue.start();
    queue.accept("1", "chat-a", "slow");
    queue.accept("2", "chat-a", "later");
    queue.accept("3", "chat-b", "other");
    queue.accept("4", "chat-a", "stop", true);
    await vi.waitFor(() => expect(seen).toEqual(["slow", "other", "stop"]));
    release();
    await vi.waitFor(() => expect(seen).toContain("later"));
    await queue.close();
    expect(journal.usage().records).toBe(0);
  });
  it("scopes uncertain lanes to one channel stream", () => {
    const { journal } = fixture();
    journal.accept({ id: "a", stream: "telegram", lane: "same", payload: "one", control: false });
    journal.mark(journal.pending("telegram")[0]!.id, "uncertain");
    journal.accept({ id: "b", stream: "feishu", lane: "same", payload: "two", control: false });
    expect(journal.pending("feishu")).toHaveLength(1);
  });

  it("blocks ordinary input behind uncertain output while preserving its stop entry", () => {
    const { journal } = fixture();
    journal.accept({ id: "output", stream: "output", lane: "chat", payload: "reply", control: false });
    journal.mark(journal.pending("output")[0]!.id, "uncertain");
    journal.accept({ id: "input", stream: "input", lane: "chat", payload: "next request", control: false });
    journal.accept({ id: "stop", stream: "input", lane: "chat", payload: "/stop", control: true });
    expect(journal.pending("input", "output").map(row => row.id)).toEqual([DeliveryJournal.id("stop")]);
    expect(journal.usage().records).toBe(3);
  });

  it("keeps admission order monotonic even when wall time moves backwards", () => {
    const { journal } = fixture();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValueOnce(200).mockReturnValueOnce(100);
      for (const id of ["first", "second"]) journal.accept({ id, stream: "input", lane: "chat", payload: id, control: false });
      const rows = journal.pending("input").map(row => journal.read<string>(row.id));
      expect(rows.map(row => row.payload)).toEqual(["first", "second"]);
      expect(rows[1]!.sequence).toBeGreaterThan(rows[0]!.sequence);
    } finally { now.mockRestore(); }
  });

  it("holds fault admission across restart and requires explicit offline acknowledgement", () => {
    const { journal, directory } = fixture();
    journal.fail();
    expect(() => journal.accept({ id: "a", stream: "input", lane: "chat", payload: "secret", control: false })).toThrow();
    journal.accept({ id: "stop", stream: "input", lane: "chat", payload: "/stop", control: true });
    expect(DeliveryJournal.status(directory).recoveryRequired).toBe(true);
    expect(JSON.stringify(DeliveryJournal.status(directory))).not.toContain("/stop");
    journal.close();
    const maintenance = new DeliveryJournal(directory, { maintenance: true }); journals.push(maintenance);
    expect(maintenance.recoveryRequired).toBe(true);
    maintenance.resolve(maintenance.inspect()[0]!.id);
    maintenance.clearRecovery();
    maintenance.close();
    const reopened = new DeliveryJournal(directory); journals.push(reopened);
    expect(reopened.recoveryRequired).toBe(false);
    expect(reopened.accept({ id: "a", stream: "input", lane: "chat", payload: "new", control: false })).toBe(true);
  });

  it("retains pending work but refuses fresh ordinary admission after an unclean exit", () => {
    const { journal, directory } = fixture();
    journal.accept({ id: "pending", stream: "input", lane: "chat", payload: "body", control: false });
    journal.close();
    writeFileSync(join(directory, "recovery-required"), "1");
    const reopened = new DeliveryJournal(directory); journals.push(reopened);
    expect(reopened.pending("input")).toHaveLength(1);
    expect(reopened.recoveryRequired).toBe(true);
    expect(() => reopened.accept({ id: "new", stream: "input", lane: "chat", payload: "new", control: false })).toThrow();
  });

});

it.each(["telegram", "feishu", "weixin"])("%s pauses faulted input while preserving output and controls through recovery", async surface => {
  const { journal, directory } = fixture();
  const stream = `${surface}:input`;
  journal.accept({ id: "ordinary", stream, lane: "chat", payload: "ordinary", control: false });
  journal.close();
  writeFileSync(join(directory, "recovery-required"), "1");
  expect(DeliveryJournal.status(directory).recoveryRequired).toBe(true);
  const restored = new DeliveryJournal(directory); journals.push(restored);
  const inputs: string[] = [], outputs: string[] = [];
  const input = new DurableInputQueue<string>({ journal: restored, stream, handle: async value => { inputs.push(value); }, onUncertain: vi.fn() });
  const output = new DurableInputQueue<string>({ journal: restored, stream: `${surface}:output`, purpose: "output", handle: async value => { outputs.push(value); }, onUncertain: vi.fn() });
  input.start(); output.start();
  input.accept("stop", "chat", "stop", true);
  output.accept("answer", "chat", "answer");
  await vi.waitFor(() => { expect(inputs).toEqual(["stop"]); expect(outputs).toEqual(["answer"]); });
  expect(restored.inspect().map(row => row.state)).toEqual(["pending"]);
  await input.close(); await output.close(); restored.close();
  const maintenance = new DeliveryJournal(directory, { maintenance: true }); journals.push(maintenance);
  maintenance.clearRecovery(); maintenance.close();
  const clean = new DeliveryJournal(directory); journals.push(clean);
  expect(DeliveryJournal.status(directory).recoveryRequired).toBe(false);
  const resumed = new DurableInputQueue<string>({ journal: clean, stream, handle: async value => { inputs.push(value); }, onUncertain: vi.fn() });
  resumed.start();
  await vi.waitFor(() => expect(inputs).toEqual(["stop", "ordinary"]));
  expect(clean.usage().records).toBe(0);
  await resumed.close();
});

it("retains in-flight input if a critical handoff fails and stops subsequent ordinary execution", async () => {
  const { journal } = fixture();
  const calls: string[] = [];
  const queue = new DurableInputQueue<string>({ journal, stream: "input", handle: async value => { calls.push(value); journal.fail(); }, onUncertain: vi.fn() });
  queue.accept("one", "chat", "one"); queue.accept("two", "chat", "two");
  queue.start();
  await vi.waitFor(() => expect(journal.usage().uncertain).toBe(1));
  expect(calls).toEqual(["one"]);
  expect(journal.inspect().map(row => row.state)).toEqual(["uncertain", "pending"]);
  await queue.close();
});

it("rolls back every grouped identity when one state update fails", () => {
  const { journal, directory } = fixture();
  for (const id of ["first", "second"]) journal.accept({ id, stream: "input", lane: "chat", control: false, payload: id });
  const rows = journal.inspect();
  const db = new DatabaseSync(join(directory, "pending.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE ON entries WHEN NEW.id='${rows[1]!.id}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    expect(() => journal.markMany(rows.map(row => row.id), "done")).toThrow("fixture failure");
    expect(journal.inspect().map(row => row.state)).toEqual(["pending", "pending"]);
    expect(journal.read(rows[0]!.id).payload).toBe("first");
  } finally { db.close(); }
});

it("cancels a grouped submission as one unresolved unit and never replays it on restart", async () => {
  const { journal } = fixture();
  const batch = vi.fn(async (_values: readonly string[], signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const options = { journal, stream: "input", groupKey: () => "album", handle: vi.fn(async () => {}), handleBatch: batch, onUncertain: vi.fn() };
  const queue = new DurableInputQueue<string>(options);
  queue.accept("one", "chat", "one"); queue.accept("two", "chat", "two"); queue.start();
  await vi.waitFor(() => expect(batch).toHaveBeenCalledOnce());
  await queue.close();
  expect(journal.inspect().map(row => row.state)).toEqual(["uncertain", "uncertain"]);
  const restored = new DurableInputQueue<string>(options);
  restored.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(batch).toHaveBeenCalledOnce();
  await restored.close();
});
