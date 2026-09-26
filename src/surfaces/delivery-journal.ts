import { assertPrivateDirectoryAccessSync, assertPrivateFileAccessSync, securePrivateDirectorySync } from "../../runtime/private-file.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DeliveryState = "pending" | "processing" | "uncertain" | "done";
export interface DeliveryRecord<T = unknown> {
  id: string;
  stream: string;
  lane: string;
  control: boolean;
  state: DeliveryState;
  createdAt: number;
  payload: T;
  sequence: number;
}
interface StoredRecord {
  id: string;
  stream: string;
  lane: string;
  control: number;
  state: DeliveryState;
  created_at: number;
  payload: Uint8Array;
  sequence: number;
}
export interface DeliveryJournalOptions {
  maximumRecords?: number;
  maximumBytes?: number;
  reservedRecords?: number;
  reservedBytes?: number;
  maintenance?: boolean;
}
export class DeliveryJournalError extends Error {
  constructor(readonly code: "full" | "invalid" | "closed") {
    super(code === "full" ? "消息待处理日志已满" : code === "closed" ? "消息待处理日志已关闭" : "消息待处理日志校验失败");
    this.name = "DeliveryJournalError";
  }
}

/** Independent pending-delivery storage; never stores bindings or full history. */
export class DeliveryJournal {
  private readonly db: DatabaseSync;
  private readonly lease: DatabaseSync;
  private readonly key: Buffer;
  private readonly maximumRecords: number;
  private readonly maximumBytes: number;
  private readonly reservedRecords: number;
  private readonly reservedBytes: number;
  private closed = false;
  private failed = false;
  private readonly maintenance: boolean;

  constructor(readonly directory: string, options: DeliveryJournalOptions = {}) {
    this.maintenance = options.maintenance ?? false;
    this.maximumRecords = options.maximumRecords ?? 10_000;
    this.maximumBytes = options.maximumBytes ?? 256 * 1024 * 1024;
    this.reservedRecords = options.reservedRecords ?? 256;
    this.reservedBytes = options.reservedBytes ?? 8 * 1024 * 1024;
    for (const value of [this.maximumRecords, this.maximumBytes, this.reservedRecords, this.reservedBytes]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new DeliveryJournalError("invalid");
    }
    if (this.maximumRecords <= this.reservedRecords || this.maximumBytes <= this.reservedBytes) throw new DeliveryJournalError("invalid");
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExisted && process.platform === "win32") securePrivateDirectorySync(directory);
    requirePrivate(directory, true);
    const leasePath = join(directory, "owner.sqlite");
    if (!existsSync(leasePath)) {
      try { const fd = openSync(leasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    requirePrivate(leasePath, false);
    this.lease = new DatabaseSync(leasePath);
    try { this.lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch (error) { this.lease.close(); throw error; }
    try {
    const path = join(directory, "pending.sqlite");
    const keyPath = join(directory, "master.key");
    if (!existsSync(keyPath)) {
      if (existsSync(path)) throw new DeliveryJournalError("invalid");
      const fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(directory);
    }
    requirePrivate(keyPath, false);
    const keyFd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { this.key = readFileSync(keyFd); } finally { closeSync(keyFd); }
    if (this.key.length !== 32) throw new DeliveryJournalError("invalid");
    if (!existsSync(path)) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
    }
    requirePrivate(path, false);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version === 0) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (tables.length !== 0) throw new DeliveryJournalError("invalid");
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, stream TEXT NOT NULL, lane TEXT NOT NULL,
            control INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','processing','uncertain','done')),
            created_at INTEGER NOT NULL, payload BLOB NOT NULL);
          CREATE INDEX pending_order ON entries(stream, state, sequence);
          CREATE INDEX uncertain_lane ON entries(stream, lane, state);
          PRAGMA user_version = 1; COMMIT;`);
        syncDirectory(directory);
      } else if (version.user_version !== 1) throw new DeliveryJournalError("invalid");
      const columns = this.db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
      if (columns.map(column => column.name).join(",") !== "sequence,id,stream,lane,control,state,created_at,payload") throw new DeliveryJournalError("invalid");
      const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      this.db.exec(`PRAGMA max_page_count=${Math.ceil((this.maximumBytes + 16 * 1024 * 1024) / pageSize)}`);
      const marker = join(directory, "recovery-required");
      if (existsSync(marker)) {
        requirePrivate(marker, false);
        const state = readFileSync(marker, "utf8");
        if (!["0", "1", "2"].includes(state)) throw new DeliveryJournalError("invalid");
        this.failed = state !== "0";
      }
      if (!this.maintenance) this.writeRecoveryMarker(this.failed ? "2" : "1");
    } catch (error) { this.db.close(); throw error; }
    } catch (error) { this.lease.close(); throw error; }
  }

  static id(value: string): string { return createHash("sha256").update(value).digest("hex"); }

  static status(directory: string): { recoveryRequired: boolean; records: ReturnType<DeliveryJournal["inspect"]> } {
    requirePrivate(directory, true);
    const path = join(directory, "pending.sqlite");
    requirePrivate(path, false);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== 1) throw new DeliveryJournalError("invalid");
      const records = db.prepare("SELECT id,stream,lane,state,created_at AS createdAt FROM entries WHERE state!='done' ORDER BY rowid").all() as ReturnType<DeliveryJournal["inspect"]>;
      const marker = join(directory, "recovery-required");
      requirePrivate(marker, false);
      const leasePath = join(directory, "owner.sqlite");
      requirePrivate(leasePath, false);
      const lease = new DatabaseSync(leasePath, { readOnly: true });
      try {
        let owned = false;
        try {
          lease.exec("PRAGMA busy_timeout=0; BEGIN");
          lease.prepare("PRAGMA schema_version").get();
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error;
          owned = true;
        }
        const state = readFileSync(marker, "utf8");
        if (!["0", "1", "2"].includes(state)) throw new DeliveryJournalError("invalid");
        return { recoveryRequired: state === "2" || (state === "1" && !owned), records };
      } finally { lease.close(); }
    } finally { db.close(); }
  }

  resolve(id: string): void {
    this.assertOpen();
    if (!this.maintenance || !/^[a-f0-9]{64}$/.test(id)) throw new DeliveryJournalError("invalid");
    if (!this.db.prepare("SELECT 1 FROM entries WHERE id=? AND state!='done'").get(id)) throw new DeliveryJournalError("invalid");
    this.mark(id, "done");
  }

  accept<T>(input: Omit<DeliveryRecord<T>, "state" | "createdAt" | "sequence">, purpose: "input" | "output" = "input"): boolean {
    this.assertOpen();
    const id = DeliveryJournal.id(input.id);
    if (this.db.prepare("SELECT 1 FROM entries WHERE id=?").get(id)) return false;
    if (this.failed && purpose === "input" && !input.control) throw new DeliveryJournalError("invalid");
    const payload = this.seal(id, JSON.stringify(input));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const usage = this.usage();
      const recordLimit = this.maximumRecords - (input.control ? 0 : this.reservedRecords);
      const byteLimit = this.maximumBytes - (input.control ? 0 : this.reservedBytes);
      if (usage.records >= recordLimit || usage.bytes + payload.length > byteLimit) throw new DeliveryJournalError("full");
      this.db.prepare("INSERT INTO entries (id,stream,lane,control,state,created_at,payload) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
        .run(id, DeliveryJournal.id(input.stream), DeliveryJournal.id(input.lane), Number(input.control), Date.now(), payload);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  pending(stream: string, blockedByStream = stream): Array<{ id: string; lane: string; control: boolean }> {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT id,lane,control FROM entries p WHERE stream=? AND state='pending'
      AND (control=1 OR NOT EXISTS (SELECT 1 FROM entries u WHERE u.stream IN (p.stream, ?) AND u.lane=p.lane AND u.state='uncertain'))
      ORDER BY rowid`).all(DeliveryJournal.id(stream), DeliveryJournal.id(blockedByStream)) as Array<{ id: string; lane: string; control: number }>;
    return rows.map(row => ({ ...row, control: Boolean(row.control) }));
  }

  read<T>(id: string): DeliveryRecord<T> {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM entries WHERE id=? AND state!='done'").get(id) as StoredRecord | undefined;
    if (!row) throw new DeliveryJournalError("invalid");
    return this.decode<T>(row);
  }

  recover(stream: string): number {
    this.assertOpen();
    return Number(this.db.prepare("UPDATE entries SET state='uncertain' WHERE stream=? AND state='processing'")
      .run(DeliveryJournal.id(stream)).changes);
  }

  mark(id: string, state: Exclude<DeliveryState, "pending">): void {
    this.markMany([id], state);
  }

  /** A grouped submission must never leave a partially completed set of identities. */
  markMany(ids: readonly string[], state: Exclude<DeliveryState, "pending">): void {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(state === "done"
        ? "UPDATE entries SET state='done', payload=x'' WHERE id=?"
        : "UPDATE entries SET state=? WHERE id=? AND state!='done'");
      for (const id of ids) {
        if (state === "done") update.run(id);
        else update.run(state, id);
      }
      if (state === "done") this.db.prepare("DELETE FROM entries WHERE state='done' AND id NOT IN (SELECT id FROM entries WHERE state='done' ORDER BY sequence DESC LIMIT 10000)").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  usage(): { records: number; bytes: number; uncertain: number } {
    this.assertOpen();
    return this.db.prepare("SELECT count(*) AS records, coalesce(sum(length(payload)),0) AS bytes, coalesce(sum(state='uncertain'),0) AS uncertain FROM entries WHERE state!='done'")
      .get() as { records: number; bytes: number; uncertain: number };
  }

  /** Redacted inspection; payload decryption is intentionally not part of this API. */
  inspect(): Array<{ id: string; stream: string; lane: string; state: DeliveryState; createdAt: number }> {
    this.assertOpen();
    return this.db.prepare("SELECT id,stream,lane,state,created_at AS createdAt FROM entries WHERE state!='done' ORDER BY rowid").all() as ReturnType<DeliveryJournal["inspect"]>;
  }

  hasPending(stream: string, lane: string): boolean {
    this.assertOpen();
    return Boolean(this.db.prepare("SELECT 1 FROM entries WHERE stream=? AND lane=? AND state!='done' LIMIT 1")
      .get(DeliveryJournal.id(stream), DeliveryJournal.id(lane)));
  }

  /** Used when a critical event cannot be durably admitted. No memory overflow queue. */
  fail(): void {
    this.failed = true;
    this.writeRecoveryMarker("2");
  }

  clearRecovery(): void {
    this.assertOpen();
    if (!this.maintenance || this.usage().uncertain > 0
      || this.db.prepare("SELECT 1 FROM entries WHERE state='processing' LIMIT 1").get()) throw new DeliveryJournalError("invalid");
    this.writeRecoveryMarker("0");
    this.failed = false;
  }

  private writeRecoveryMarker(value: string): void {
    const path = join(this.directory, "recovery-required");
    if (existsSync(path)) requirePrivate(path, false);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(this.directory);
  }

  get recoveryRequired(): boolean { return this.failed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { if (!this.maintenance) this.writeRecoveryMarker(this.failed ? "2" : "0"); }
    finally { this.db.close(); this.lease.close(); this.key.fill(0); }
  }
  private assertOpen(): void { if (this.closed) throw new DeliveryJournalError("closed"); }
  private seal(id: string, value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  private decode<T>(row: StoredRecord): DeliveryRecord<T> {
    try {
      const bytes = Buffer.from(row.payload);
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(row.id));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const input = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as Omit<DeliveryRecord<T>, "state" | "createdAt" | "sequence">;
      if (DeliveryJournal.id(input.id) !== row.id || DeliveryJournal.id(input.stream) !== row.stream || DeliveryJournal.id(input.lane) !== row.lane) throw new DeliveryJournalError("invalid");
      return { ...input, id: row.id, state: row.state, createdAt: row.created_at, sequence: row.sequence };
    } catch { throw new DeliveryJournalError("invalid"); }
  }
}

function requirePrivate(path: string, directory: boolean): void {
  if (process.platform === "win32") {
    if (directory) assertPrivateDirectoryAccessSync(path);
    else assertPrivateFileAccessSync(path);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new DeliveryJournalError("invalid");
  }
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
