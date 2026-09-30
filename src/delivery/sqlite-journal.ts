import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPrivateFileSync, securePrivateDirectorySync, securePrivateFileSync } from "../../runtime/private-file.mjs";
import { readDeliveryQueueRows } from "./queue-reader.js";
import { defaultDeliveryLimits, deliverySchemaVersion, DeliveryError, type DeliveryLimits, type DeliveryRecord, type DeliveryState, type DeliverySubmission, type DeliverySummary, type JournalCommand, type JournalResult } from "./types.js";

interface Row {
  sequence: number; id: string; account: string; conversation: string;
  state: DeliveryState; created_at: number; attempt: number;
  payload: Uint8Array; nonce: Uint8Array; tag: Uint8Array;
  progress: string;
  bytes: number;
}

/** Only constructed in the journal Worker in production. */
export class SqliteDeliveryJournal {
  private readonly database: DatabaseSync;
  private readonly key: Buffer;
  private readonly writerLock: DatabaseSync;
  private closed = false;
  // Process-local scheduling policy only; retained rows and quota stay unchanged.
  private readonly releasedBarriers = new Set<string>();

  constructor(private readonly directory: string, private readonly limits: DeliveryLimits = { ...defaultDeliveryLimits }, private readonly mode: "runtime" | "maintenance" = "runtime") {
    if (mode !== "runtime" && mode !== "maintenance") throw new DeliveryError("storage");
    if (mode === "maintenance" && (!existsSync(join(directory, "outbox.sqlite3")) || !existsSync(join(directory, "payload.key")))) throw new DeliveryError("storage");
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new DeliveryError("storage");
    }
    if (mode === "runtime") mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.getuid && dir.uid !== process.getuid())) throw new DeliveryError("storage");
    securePrivateDirectorySync(directory);
    this.syncDirectory(dirname(directory));
    this.writerLock = this.acquireLock();
    const path = join(directory, "outbox.sqlite3");
    const keyPath = join(directory, "payload.key");
    let database: DatabaseSync | undefined;
    try {
      const fresh = !existsSync(path);
      if (mode === "maintenance" && fresh) throw new DeliveryError("storage");
      if (!existsSync(keyPath)) {
        if (!fresh) throw new DeliveryError("storage");
        const descriptor = openSync(keyPath, "wx", 0o600);
        try { writeFileSync(descriptor, randomBytes(32).toString("hex")); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        securePrivateFileSync(keyPath);
        this.syncDirectory();
      }
      const encoded = readPrivateFileSync(keyPath, 64);
      if (!/^[0-9a-f]{64}$/u.test(encoded)) throw new DeliveryError("storage");
      this.key = Buffer.from(encoded, "hex");
      if (fresh) {
        closeSync(openSync(path, "wx", 0o600));
        securePrivateFileSync(path);
      }
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (process.getuid && metadata.uid !== process.getuid())
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new DeliveryError("storage");
      database = new DatabaseSync(path);
      this.database = database;
      database.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON; PRAGMA max_page_count=131072;");
      if (database.prepare("PRAGMA page_size").get()?.page_size !== 4096
        || database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new DeliveryError("storage");
      if (fresh) {
        database.exec(`BEGIN IMMEDIATE;
          CREATE TABLE metadata (version INTEGER NOT NULL, proof BLOB NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL) STRICT;
          CREATE TABLE deliveries (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE, account TEXT NOT NULL, conversation TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','sending','uncertain','blocked')),
            created_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL,
            payload BLOB NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL, progress TEXT NOT NULL DEFAULT '[]'
          ) STRICT;
          CREATE INDEX conversation_order ON deliveries(conversation,sequence);
          CREATE INDEX account_usage ON deliveries(account);
          PRAGMA user_version=1;`);
        const proof = this.encrypt("delivery-v1", "metadata");
        database.prepare("INSERT INTO metadata VALUES(?,?,?,?)").run(deliverySchemaVersion, proof.payload, proof.nonce, proof.tag);
        database.exec("COMMIT");
        this.syncDirectory();
      }
      const version = database.prepare("PRAGMA user_version").get()?.user_version;
      const proofs = database.prepare("SELECT * FROM metadata").all();
      const proof = proofs[0];
      if (version !== deliverySchemaVersion || proofs.length !== 1 || proof?.version !== deliverySchemaVersion
        || this.decrypt(proof.proof as Uint8Array, proof.nonce as Uint8Array, proof.tag as Uint8Array, "metadata") !== "delivery-v1") throw new DeliveryError("storage");
      // Keyset reads keep one payload in memory and retain the statement across
      // calls; early Node 22 iterators can outlive their collected statement.
      const recovery = database.prepare("SELECT * FROM deliveries WHERE sequence>? ORDER BY sequence LIMIT 1");
      let sequence = 0;
      for (let row = recovery.get(sequence); row; row = recovery.get(sequence)) {
        this.decode(row as unknown as Row);
        sequence = Number(row.sequence);
      }
      // A network request may have succeeded before the previous process lost its acknowledgement.
      if (mode === "runtime") database.exec("UPDATE deliveries SET state='uncertain' WHERE state='sending'");
      // Only the single writer can clean interrupted, private render snapshots.
      for (const name of mode === "runtime" ? readdirSync(directory) : []) {
        if (!/^image-[A-Za-z0-9]{6}$/u.test(name)) continue;
        const temporary = join(directory, name);
        const metadata = lstatSync(temporary);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new DeliveryError("storage");
        for (const file of readdirSync(temporary)) {
          if (file !== "result.png" && file !== "result.jpeg") throw new DeliveryError("storage");
          unlinkSync(join(temporary, file));
        }
        rmdirSync(temporary);
      }
    } catch {
      try { database?.close(); } finally { this.writerLock.close(); }
      throw new DeliveryError("storage");
    }
  }

  execute(command: JournalCommand): JournalResult {
    if (this.closed) throw new DeliveryError("closed");
    if (this.mode === "maintenance" && !["queueEntry", "queueEntries", "resolve", "resolveBatch", "close"].includes(command.type)) throw new DeliveryError("conflict");
    switch (command.type) {
      case "submit": return this.submit(command.value);
      case "next": {
        const excluded = new Set(command.excluded);
        const released = JSON.stringify([...this.releasedBarriers]);
        const next = this.database.prepare(`SELECT d.* FROM deliveries d WHERE d.state='pending' AND d.sequence>?
          AND NOT EXISTS(SELECT 1 FROM deliveries p WHERE p.conversation=d.conversation AND p.sequence<d.sequence
            AND NOT (p.state IN ('uncertain','blocked') AND p.id IN (SELECT value FROM json_each(?))))
          ORDER BY d.sequence LIMIT 1`);
        let sequence = 0;
        for (let raw = next.get(sequence, released); raw; raw = next.get(sequence, released)) {
          const row = raw as unknown as Row;
          sequence = row.sequence;
          if (!excluded.has(row.conversation) && (!command.accounts || command.accounts.includes(row.account))) return this.decode(row);
        }
        return null;
      }
      case "read": {
        const row = this.database.prepare("SELECT * FROM deliveries WHERE id=?").get(command.id);
        return row ? this.decode(row as unknown as Row) : null;
      }
      case "queueEntries": {
        if (!command.ids.length || command.ids.length > 50 || new Set(command.ids).size !== command.ids.length) throw new DeliveryError("conflict");
        return command.ids.map(id => readDeliveryQueueRows(this.database, 0, null, id)[0] ?? null);
      }
      case "queueEntry": return readDeliveryQueueRows(this.database, 0, null, command.id)[0] ?? null;
      case "releaseBarrier": {
        const state = this.database.prepare("SELECT state FROM deliveries WHERE id=?").get(command.id)?.state;
        if (state !== "uncertain" && state !== "blocked") return false;
        this.releasedBarriers.add(command.id);
        return true;
      }
      case "state": return this.database.prepare("UPDATE deliveries SET state=?, attempt=attempt+? WHERE id=? AND state=?")
        .run(command.to, command.to === "sending" ? 1 : 0, command.id, command.from).changes === 1;
      case "acknowledge": return this.database.prepare("DELETE FROM deliveries WHERE id=? AND state='sending'").run(command.id).changes === 1;
      case "summary": return this.summary();
      case "resolveBatch": {
        if (!command.entries.length || command.entries.length > 50 || new Set(command.entries.map(entry => entry.id)).size !== command.entries.length) throw new DeliveryError("conflict");
        this.database.exec("BEGIN IMMEDIATE");
        try {
          for (const entry of command.entries) {
            const row = readDeliveryQueueRows(this.database, 0, null, entry.id)[0];
            if (!row || row.revision !== entry.revision || !["uncertain", "blocked"].includes(row.state)) {
              this.database.exec("ROLLBACK");
              return false;
            }
          }
          for (const entry of command.entries) this.execute({ type: "resolve", id: entry.id, action: command.action });
          this.database.exec("COMMIT");
          return true;
        } catch (error) {
          try { this.database.exec("ROLLBACK"); } catch { /* Preserve the failure. */ }
          throw error;
        }
      }
      case "resolve": {
        this.releasedBarriers.delete(command.id);
        // Offline operator acknowledgement only; never called by the scheduler.
        if (command.action === "confirm") return this.database.prepare("DELETE FROM deliveries WHERE id=? AND state IN ('uncertain','blocked')").run(command.id).changes === 1;
        return this.database.prepare("UPDATE deliveries SET state='pending',progress='[]' WHERE id=? AND state IN ('uncertain','blocked')").run(command.id).changes === 1;
      }
      case "checkpoint": {
        const row = this.database.prepare("SELECT progress FROM deliveries WHERE id=? AND state='sending'").get(command.id);
        if (!row) throw new DeliveryError("conflict");
        const progress = JSON.parse(String(row.progress)) as DeliveryRecord["progress"];
        progress.push(command.value);
        const encoded = JSON.stringify(progress);
        if (progress.length > 256 || Buffer.byteLength(encoded) > 64 * 1024) throw new DeliveryError("capacity");
        this.database.prepare("UPDATE deliveries SET progress=? WHERE id=?").run(encoded, command.id);
        return true;
      }
      case "list": return this.database.prepare("SELECT sequence,id,account,conversation,state,created_at AS createdAt,attempt,progress,bytes FROM deliveries WHERE sequence>? ORDER BY sequence LIMIT ?")
        .all(command.after, Math.min(100, Math.max(1, command.limit))).map((row) => ({ ...row, progress: JSON.parse(String(row.progress)) as unknown })) as unknown as Array<Omit<DeliveryRecord, "payload">>;
      case "close": this.close(); return null;
    }
  }

  private submit(value: DeliverySubmission): number {
    const payloadBytes = Buffer.byteLength(value.payload, "utf8");
    if (payloadBytes > this.limits.recordBytes) throw new DeliveryError("record-too-large");
    const bytes = payloadBytes + 64 * 1024; // Reserve progress metadata before accepting the result.
    if (!value.id || !value.account || !value.conversation || [value.id, value.account, value.conversation].some((key) => Buffer.byteLength(key) > 4096)) throw new DeliveryError("storage");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const total = this.summary();
      const account = this.database.prepare("SELECT COUNT(*) AS records, COALESCE(SUM(bytes),0) AS bytes FROM deliveries WHERE account=?").get(value.account)!;
      if (total.records >= this.limits.records || total.bytes + bytes > this.limits.bytes) throw new DeliveryError("capacity");
      if (Number(account.records) >= this.limits.accountRecords || Number(account.bytes) + bytes > this.limits.accountBytes) throw new DeliveryError("account-capacity");
      const encrypted = this.encrypt(value.payload, this.aad(value));
      const result = this.database.prepare("INSERT INTO deliveries(id,account,conversation,state,created_at,bytes,payload,nonce,tag) VALUES(?,?,?,'pending',?,?,?,?,?)")
        .run(value.id, value.account, value.conversation, Date.now(), bytes, encrypted.payload, encrypted.nonce, encrypted.tag);
      this.database.exec("COMMIT");
      return Number(result.lastInsertRowid);
    } catch (error) {
      // SQLITE_FULL may already have rolled the transaction back.
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original classified failure. */ }
      throw error instanceof DeliveryError ? error : new DeliveryError("storage");
    }
  }

  private summary(): DeliverySummary {
    const result: DeliverySummary = { records: 0, bytes: 0, pending: 0, sending: 0, uncertain: 0, blocked: 0 };
    for (const row of this.database.prepare("SELECT state, COUNT(*) AS records, SUM(bytes) AS bytes FROM deliveries GROUP BY state").all()) {
      result.records += Number(row.records);
      result.bytes += Number(row.bytes);
      result[row.state as DeliveryState] = Number(row.records);
    }
    return result;
  }

  private aad(value: Pick<DeliverySubmission, "id" | "account" | "conversation">): string {
    return JSON.stringify([deliverySchemaVersion, value.id, value.account, value.conversation]);
  }

  private encrypt(text: string, aad: string): { payload: Buffer; nonce: Buffer; tag: Buffer } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(aad));
    return { payload: Buffer.concat([cipher.update(text, "utf8"), cipher.final()]), nonce, tag: cipher.getAuthTag() };
  }

  private decrypt(payload: Uint8Array, nonce: Uint8Array, tag: Uint8Array, aad: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  }

  private decode(row: Row): DeliveryRecord {
    return { id: row.id, account: row.account, conversation: row.conversation, sequence: row.sequence,
      state: row.state, createdAt: row.created_at, attempt: row.attempt,
      bytes: row.bytes,
      progress: JSON.parse(row.progress) as DeliveryRecord["progress"],
      payload: this.decrypt(row.payload, row.nonce, row.tag, this.aad(row)) };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
    this.key.fill(0);
    this.writerLock.close();
  }

  private acquireLock(): DatabaseSync {
    const path = join(this.directory, "writer.sqlite3");
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw new DeliveryError("storage");
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || (process.getuid && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new DeliveryError("storage");
    securePrivateFileSync(path);
    const lock = new DatabaseSync(path);
    try {
      // Same OS-backed exclusive-lock strategy as the metrics store. Process or
      // Worker death releases it without PID reuse or stale-file deletion races.
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
      return lock;
    } catch { lock.close(); throw new DeliveryError("conflict"); }
  }

  private syncDirectory(path = this.directory): void {
    if (process.platform === "win32") return;
    const descriptor = openSync(path, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
}
