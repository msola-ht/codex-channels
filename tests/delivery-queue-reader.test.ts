import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import { readDeliveryPayload, readDeliveryQueue } from "../src/delivery/queue-reader.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delivery-read-"));
  directories.push(root);
  return join(root, "outbox");
}
it("does not initialize a missing outbox", () => {
  const directory = fixture();
  expect(readDeliveryQueue(directory)).toMatchObject({ state: "missing", summary: null, records: [] });
  expect(existsSync(directory)).toBe(false);
});
it("reads a bounded consistent snapshot beside the writer without recovery, decryption or checkpoint disclosure", () => {
  const directory = fixture();
  const writer = new SqliteDeliveryJournal(directory);
  try {
    for (let index = 0; index < 53; index++) writer.execute({ type: "submit", value: {
      id: `record-${index}`, account: '["telegram","default"]', conversation: '["telegram","default","chat"]', payload: "SECRET BODY",
    } });
    writer.execute({ type: "state", id: "record-0", from: "pending", to: "sending" });
    writer.execute({ type: "checkpoint", id: "record-0", value: { operation: "SECRET OPERATION", state: "confirmed", messageId: "SECRET MESSAGE" } });
    const before = readFileSync(join(directory, "outbox.sqlite3"));
    const snapshot = readDeliveryQueue(directory);
    expect(snapshot.records).toHaveLength(50);
    expect(snapshot.summary).toMatchObject({ records: 53, sending: 1, pending: 52 });
    expect(readDeliveryQueue(directory, { id: "record-0" }).records[0]).toMatchObject({ state: "sending", attempt: 1, confirmed: 1, checkpoints: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(snapshot.records.map(row => row.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => 53 - i));
    const nextPage = readDeliveryQueue(directory, { before: snapshot.nextCursor! });
    expect(nextPage.records.map(row => row.sequence)).toEqual([3, 2, 1]);
    expect(nextPage.nextCursor).toBeNull();
    expect(readDeliveryQueue(directory, { state: "pending" }).records.map(row => row.sequence))
      .toEqual(snapshot.records.map(row => row.sequence));
    expect(readDeliveryQueue(directory, { state: "sending" }).records).toHaveLength(1);
    expect(readDeliveryQueue(directory, { id: "record-0" }).records).toHaveLength(1);
    expect(readDeliveryQueue(directory, { state: "uncertain" }).records).toHaveLength(0);
    expect(readFileSync(join(directory, "outbox.sqlite3"))).toEqual(before);
    expect(writer.execute({ type: "read", id: "record-0" })).toMatchObject({ state: "sending" });
  } finally { writer.close(); }
});
it("fails closed on unsupported schema and malformed queries", () => {
  const directory = fixture();
  new SqliteDeliveryJournal(directory).close();
  const db = new DatabaseSync(join(directory, "outbox.sqlite3"));
  db.exec("PRAGMA user_version=99"); db.close();
  expect(() => readDeliveryQueue(directory)).toThrow();
  expect(() => readDeliveryQueue(directory, { before: -1 })).toThrow();
});
it.skipIf(process.platform === "win32")("rejects public permissions and symlinked outboxes", () => {
  const directory = fixture();
  new SqliteDeliveryJournal(directory).close();
  chmodSync(join(directory, "outbox.sqlite3"), 0o644);
  expect(() => readDeliveryQueue(directory)).toThrow();
  chmodSync(join(directory, "outbox.sqlite3"), 0o600);
  const link = `${directory}-link`;
  symlinkSync(directory, link);
  expect(() => readDeliveryQueue(link)).toThrow();
});

it("maintenance never initializes missing data or exposes scheduling commands", () => {
  const directory = fixture();
  expect(() => new SqliteDeliveryJournal(directory, undefined, "maintenance")).toThrow();
  expect(existsSync(directory)).toBe(false);
  const writer = new SqliteDeliveryJournal(directory);
  writer.execute({ type: "submit", value: { id: "record", account: "account", conversation: "chat", payload: "SECRET" } });
  writer.execute({ type: "state", id: "record", from: "pending", to: "sending" });
  writer.close();
  const maintenance = new SqliteDeliveryJournal(directory, undefined, "maintenance");
  try {
    expect(maintenance.execute({ type: "queueEntry", id: "record" })).toMatchObject({ state: "sending" });
    expect(() => maintenance.execute({ type: "next", excluded: [] })).toThrow("conflict");
    expect(() => maintenance.execute({ type: "read", id: "record" })).toThrow("conflict");
    expect(maintenance.execute({ type: "resolve", id: "record", action: "retry" })).toBe(false);
  } finally { maintenance.close(); }
  expect(readDeliveryQueue(directory).records[0]?.state).toBe("sending");
});

it("keeps batch changes atomic when one revision is stale", () => {
  const directory = fixture();
  const writer = new SqliteDeliveryJournal(directory);
  try {
    for (const id of ["one", "two"]) {
      writer.execute({ type: "submit", value: { id, account: "a", conversation: "c", payload: "text" } });
      writer.execute({ type: "state", id, from: "pending", to: "blocked" });
    }
    const entries = readDeliveryQueue(directory).records.map(({ id, revision }) => ({ id, revision }));
    writer.execute({ type: "state", id: "two", from: "blocked", to: "uncertain" });
    expect(writer.execute({ type: "resolveBatch", action: "confirm", entries })).toBe(false);
    expect(readDeliveryQueue(directory).records).toHaveLength(2);
    const current = readDeliveryQueue(directory).records.map(({ id, revision }) => ({ id, revision }));
    expect(writer.execute({ type: "resolveBatch", action: "retry", entries: current })).toBe(true);
    expect(readDeliveryQueue(directory).records.every(row => row.state === "pending")).toBe(true);
  } finally { writer.close(); }
});
it("authenticates payload reads without state recovery and fails on a tampered authentication tag", () => {
  const directory = fixture();
  const writer = new SqliteDeliveryJournal(directory);
  try {
    writer.execute({ type: "submit", value: { id: "one", account: "a", conversation: "c", payload: "actual body" } });
    writer.execute({ type: "state", id: "one", from: "pending", to: "sending" });
    expect(readDeliveryPayload(directory, "one")).toMatchObject({ payload: "actual body", row: { state: "sending" } });
    expect(readDeliveryPayload(directory, "missing")).toBeNull();
  } finally { writer.close(); }
  const db = new DatabaseSync(join(directory, "outbox.sqlite3"));
  db.prepare("UPDATE deliveries SET tag=? WHERE id='one'").run(Buffer.alloc(16)); db.close();
  expect(() => readDeliveryPayload(directory, "one")).toThrow();
});
