import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createCipheriv } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import { readDeliveryEntries, readDeliveryPayloads, readDeliveryPayload, readDeliveryQueue } from "../src/delivery/queue-reader.js";

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

it("reads the existing v1 encryption format independently of the shared codec", () => {
  const directory = fixture();
  const writer = new SqliteDeliveryJournal(directory);
  writer.execute({ type: "submit", value: { id: "one", account: "a", conversation: "c", payload: "fixture body" } });
  writer.close();
  const key = Buffer.from(readFileSync(join(directory, "payload.key"), "utf8"), "hex");
  // Fixed nonce is only for this isolated fixture, never used by the production encoder.
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from('[1,"one","a","c"]'));
  const payload = Buffer.concat([cipher.update("fixture body", "utf8"), cipher.final()]);
  const db = new DatabaseSync(join(directory, "outbox.sqlite3"));
  try {
    db.prepare("UPDATE deliveries SET payload=?,nonce=?,tag=? WHERE id='one'")
      .run(payload, nonce, cipher.getAuthTag());
  } finally { db.close(); key.fill(0); }
  expect(readDeliveryPayload(directory, "one")?.payload).toBe("fixture body");
  const reopened = new SqliteDeliveryJournal(directory);
  try { expect(reopened.execute({ type: "read", id: "one" })).toMatchObject({ payload: "fixture body" }); }
  finally { reopened.close(); }
});

it.each(["id", "account", "conversation"] as const)("rejects a changed %s in both payload readers", field => {
  const directory = fixture();
  const writer = new SqliteDeliveryJournal(directory);
  writer.execute({ type: "submit", value: { id: "one", account: "a", conversation: "c", payload: "body" } });
  writer.close();
  const db = new DatabaseSync(join(directory, "outbox.sqlite3"));
  try { db.prepare(`UPDATE deliveries SET ${field}=? WHERE id='one'`).run("changed"); }
  finally { db.close(); }
  const id = field === "id" ? "changed" : "one";
  expect(() => readDeliveryPayload(directory, id)).toThrow();
  expect(readDeliveryPayloads(directory, [id], (_row, body) => body)).toEqual([null]);
  expect(() => new SqliteDeliveryJournal(directory)).toThrow("storage");
});

it("uses indexed lookups and one read transaction for batch metadata without global aggregates", () => {
  const directory = fixture();
  const writer = new SqliteDeliveryJournal(directory);
  writer.execute({ type: "submit", value: { id: "one", account: "a", conversation: "c", payload: "body" } });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    expect(readDeliveryEntries(directory, ["one", "missing"]).map(row => row?.id ?? null)).toEqual(["one", null]);
    const sql = prepare.mock.calls.map(([query]) => query);
    expect(sql.some(query => query.includes("GROUP BY"))).toBe(false);
    expect(sql.filter(query => query === "PRAGMA user_version")).toHaveLength(1);
    const lookup = sql.find(query => query.includes("SELECT id,sequence"))!;
    readDeliveryQueue(directory, { before: 10 });
    const page = prepare.mock.calls.map(([query]) => query).find(query => query.includes("sequence<?"))!;
    const db = new DatabaseSync(join(directory, "outbox.sqlite3"), { readOnly: true });
    try {
      expect(db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all("one").some(row => String(row.detail).includes("SEARCH deliveries USING INDEX"))).toBe(true);
      expect(db.prepare(`EXPLAIN QUERY PLAN ${page}`).all(10).some(row => String(row.detail).includes("SEARCH deliveries USING INTEGER PRIMARY KEY"))).toBe(true);
    } finally { db.close(); }
    expect(readDeliveryPayloads(directory, ["one", "missing"], (_row, payload) => payload.length)).toEqual([4, null]);
    expect(() => readDeliveryEntries(directory, ["one", "one"])).toThrow();
  } finally { prepare.mockRestore(); writer.close(); }
});

it("reads a bounded metadata batch through the writer without changing input order", () => {
  const writer = new SqliteDeliveryJournal(fixture());
  try {
    writer.execute({ type: "submit", value: { id: "one", account: "a", conversation: "c", payload: "body" } });
    expect(writer.execute({ type: "queueEntries", ids: ["missing", "one"] })).toEqual([null, expect.objectContaining({ id: "one" })]);
    expect(() => writer.execute({ type: "queueEntries", ids: [] })).toThrow("conflict");
    expect(() => writer.execute({ type: "queueEntries", ids: ["one", "one"] })).toThrow("conflict");
    expect(() => writer.execute({ type: "queueEntries", ids: Array.from({ length: 51 }, (_, i) => String(i)) })).toThrow("conflict");
  } finally { writer.close(); }
});
