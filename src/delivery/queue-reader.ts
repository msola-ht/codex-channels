import { lstatSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readPrivateFileSync } from "../../runtime/private-file.mjs";
import { deliverySchemaVersion, type DeliveryQueueEntry, type DeliveryQueueSnapshot, type DeliveryState } from "./types.js";

const integer = z.number().int().nonnegative().safe();
const stateSchema = z.enum(["pending", "sending", "uncertain", "blocked"]);
const rowSchema = z.object({
  id: z.string().min(1).max(4096), sequence: integer,
  account: z.string().min(1).max(4096), conversation: z.string().min(1).max(4096),
  state: stateSchema, createdAt: integer, attempt: integer, bytes: integer,
  confirmed: integer, checkpoints: integer,
});

/** Also used on the maintenance writer's existing connection, after taking its lock. */
export function readDeliveryQueueRows(db: DatabaseSync, before: number, filter: DeliveryState | null, id: string | null) {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (before !== 0) { conditions.push("sequence<?"); parameters.push(before); }
  if (filter !== null) { conditions.push("state=?"); parameters.push(filter); }
  if (id !== null) { conditions.push("id=?"); parameters.push(id); }
  return db.prepare(`SELECT id,sequence,account,conversation,state,created_at AS createdAt,attempt,bytes,nonce,tag,progress,
    json_array_length(progress) AS checkpoints,
    (SELECT COUNT(*) FROM json_each(progress) WHERE json_extract(value,'$.state')='confirmed') AS confirmed
    FROM deliveries ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY sequence DESC LIMIT 51`)
    .all(...parameters).map(raw => {
      const row = rowSchema.parse(raw);
      const nonce = z.instanceof(Uint8Array).refine(value => value.length === 12).parse(raw.nonce);
      const tag = z.instanceof(Uint8Array).refine(value => value.length === 16).parse(raw.tag);
      // The GCM identity binds the immutable payload; full progress catches same-count edits.
      // Hash only metadata, never read/decrypt the payload or expose checkpoint contents.
      const revision = createHash("sha256").update(JSON.stringify({ row, progress: raw.progress,
        nonce: Buffer.from(nonce).toString("hex"), tag: Buffer.from(tag).toString("hex") })).digest("hex");
      return { ...row, revision };
    });
}

function inspect(path: string, directory: boolean): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.getuid && stat.uid !== process.getuid())
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Unsafe delivery path");
  return true;
}

/** Read-only transaction, no recovery, key access, writer lock or directory creation. */
export function readDeliveryQueue(directory: string, options: { before?: number; state?: DeliveryState; id?: string } = {}): DeliveryQueueSnapshot {
  const before = integer.parse(options.before ?? 0);
  const filter = options.state === undefined ? null : stateSchema.parse(options.state);
  const id = options.id === undefined ? null : z.string().min(1).max(4096).parse(options.id);
  const path = join(directory, "outbox.sqlite3");
  if (!inspect(directory, true) || !inspect(path, false)) {
    return { state: "missing", observedAt: Date.now(), summary: null, records: [], nextCursor: null };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; BEGIN;");
    if (db.prepare("PRAGMA user_version").get()?.user_version !== deliverySchemaVersion) throw new Error("Unsupported delivery schema");
    const metadata = db.prepare("SELECT version FROM metadata").all();
    if (metadata.length !== 1 || metadata[0]?.version !== deliverySchemaVersion) throw new Error("Invalid delivery metadata");
    const summary = { records: 0, bytes: 0, pending: 0, sending: 0, uncertain: 0, blocked: 0 };
    for (const row of db.prepare("SELECT state,COUNT(*) AS records,SUM(bytes) AS bytes FROM deliveries GROUP BY state").all()) {
      const state = stateSchema.parse(row.state);
      const count = integer.parse(row.records);
      summary[state] = count;
      summary.records += count;
      summary.bytes += integer.parse(row.bytes);
    }
    const rows = readDeliveryQueueRows(db, before, filter, id);
    const records = rows.slice(0, 50);
    return { state: "available", observedAt: Date.now(), summary, records,
      nextCursor: rows.length > 50 ? records.at(-1)!.sequence : null };
  } finally { db.close(); }
}

/** Metadata lookup in one transaction, without global aggregates or payload access. */
export function readDeliveryEntries(directory: string, ids: string[]): Array<DeliveryQueueEntry | null> {
  validateIds(ids);
  return withReadDatabase(directory, db => ids.map(id => readDeliveryQueueRows(db, 0, null, id)[0] ?? null)) ?? ids.map(() => null);
}

function validateIds(ids: string[]) {
  z.array(z.string().min(1).max(4096)).min(1).max(50).refine(values => new Set(values).size === values.length).parse(ids);
}

function withReadDatabase<T>(directory: string, read: (db: DatabaseSync) => T): T | null {
  const path = join(directory, "outbox.sqlite3");
  if (!inspect(directory, true) || !inspect(path, false)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; BEGIN;");
    if (db.prepare("PRAGMA user_version").get()?.user_version !== deliverySchemaVersion) throw new Error("Unsupported delivery schema");
    const metadata = db.prepare("SELECT version FROM metadata").all();
    if (metadata.length !== 1 || metadata[0]?.version !== deliverySchemaVersion) throw new Error("Invalid delivery metadata");
    return read(db);
  } finally { db.close(); }
}

function decryptPayload(db: DatabaseSync, key: Buffer, row: DeliveryQueueEntry): string {
  const raw = db.prepare("SELECT payload,nonce,tag FROM deliveries WHERE id=?").get(row.id)!;
  const payload = z.instanceof(Uint8Array).refine(value => value.length <= 4 * 1024 * 1024).parse(raw.payload);
  const decipher = createDecipheriv("aes-256-gcm", key, z.instanceof(Uint8Array).parse(raw.nonce));
  decipher.setAAD(Buffer.from(JSON.stringify([deliverySchemaVersion, row.id, row.account, row.conversation])));
  decipher.setAuthTag(z.instanceof(Uint8Array).parse(raw.tag));
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

function readKey(directory: string): Buffer {
  const key = readPrivateFileSync(join(directory, "payload.key"), 64);
  if (!/^[0-9a-f]{64}$/u.test(key)) throw new Error("Invalid delivery key");
  return Buffer.from(key, "hex");
}

/** Project one authenticated payload at a time; never accumulate a batch of raw bodies. */
export function readDeliveryPayloads<T>(directory: string, ids: string[], project: (row: DeliveryQueueEntry, payload: string) => T): Array<T | null> {
  validateIds(ids);
  return withReadDatabase(directory, db => {
    const key = readKey(directory);
    return ids.map(id => {
      const row = readDeliveryQueueRows(db, 0, null, id)[0];
      if (!row) return null;
      try { return project(row, decryptPayload(db, key, row)); }
      catch { return null; }
    });
  }) ?? ids.map(() => null);
}

/** Explicit single-record inspection; no writer recovery. */
export function readDeliveryPayload(directory: string, id: string) {
  z.string().min(1).max(4096).parse(id);
  return withReadDatabase(directory, db => {
    const row = readDeliveryQueueRows(db, 0, null, id)[0];
    return row ? { row, payload: decryptPayload(db, readKey(directory), row) } : null;
  });
}
