import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderProxyMetrics } from "./response-metrics-observer.js";
import { securePrivateDirectory, securePrivateFile, writePrivateFileAtomic } from "../../runtime/private-file.mjs";
import { modelTrafficDumpFileSizeLimitBytes, protectModelTrafficDumpSession, pruneModelTrafficDumpSessionsAsync } from "./traffic-dump-retention.js";

const sessionRotationIntervalMs = 24 * 60 * 60 * 1_000;
const maximumPendingBytes = 14 * 1_048_576;
const maximumPendingItems = 4096;
const maximumPendingTraceBytes = 4 * 1_048_576;
const reservedIndexBytes = 256 * 1024;
const reservedIndexItems = 128;
const maximumSessions = 128;
const operationBudgetMs = 5000;

export interface TrafficPayloadPart {
  bytes: number;
  encoding: "base64" | "utf8";
  file: string;
  offset: number;
}

export interface TrafficDumpSession {
  acceptedBytes: number;
  activeInteractions: number;
  closing: boolean;
  interactionCount: number;
  payloadFileIndex: number;
  payloadWrittenBytes: number;
  sessionDirectory: string;
  startedAtMs: number;
  traceFileIndex: number;
  traceWrittenBytes: number;
  writerSession: string;
}

interface PendingBudget { bytes: number; items: number; traceBytes: number }
interface TrafficDumpStorageOptions {
  directory: string;
  label: string;
  onError: (error: Error) => void;
  onCapacity: (error: Error) => void;
  retentionDays: number;
  maximumPendingBytes?: number;
  pendingBudget?: PendingBudget;
  rotateAfterBytes?: number;
  retentionManagedExternally?: boolean;
  onBytesAccepted?: (bytes: number) => void;
}

type WriteJob = { session: TrafficDumpSession; name: string; content: string | Buffer; bytes: number; manifestBytes?: number; trace?: true };
type RetireJob = { session: TrafficDumpSession; bytes: 0 };
type Job = WriteJob | RetireJob;
type SessionFiles = { prepared: boolean; files: Map<string, FileHandle> };

/** 同步分配稳定引用；所有磁盘操作由有界旁路队列异步执行。 */
export class TrafficDumpStorage {
  private readonly label: string;
  private readonly budget: PendingBudget;
  private readonly jobs: Job[] = [];
  private readonly files = new Map<TrafficDumpSession, SessionFiles>();
  private readonly protections = new Map<TrafficDumpSession, () => void>();
  private readonly retirements = new Map<TrafficDumpSession, { promise: Promise<void>; resolve: () => void }>();
  private readonly abortController = new AbortController();
  private currentSession: TrafficDumpSession | undefined;
  private running: Promise<void> | undefined;
  private maintenance: Promise<void> | undefined;
  private maintenanceAgain = false;
  private closed = false;
  private failed = false;
  private closing: Promise<void> | undefined;
  private cleanupTask: Promise<void> | undefined;
  private readonly capacityNotices = new Set<string>();

  constructor(private readonly options: TrafficDumpStorageOptions, private readonly state: { sessions: Set<TrafficDumpSession> }) {
    this.label = options.label.replace(/[^A-Za-z0-9._-]+/gu, "_");
    this.budget = options.pendingBudget ?? { bytes: 0, items: 0, traceBytes: 0 };
  }

  sessionForConnection(startedAtMs: number): TrafficDumpSession { return this.ensureCurrentSession(startedAtMs, false); }
  currentSessionOr(fallback: TrafficDumpSession): TrafficDumpSession { return this.currentSession ?? fallback; }
  beginLogicalInteraction(startedAtMs: number): TrafficDumpSession {
    const session = this.ensureCurrentSession(startedAtMs, true);
    session.activeInteractions++;
    return session;
  }
  completeLogicalInteraction(session: TrafficDumpSession): void {
    if (session.activeInteractions > 0) session.activeInteractions--;
    if (session !== this.currentSession) void this.retireSession(session);
  }
  nextInteractionId(session: TrafficDumpSession): number { return ++session.interactionCount; }
  /** Release an idle current session only after its accepted writes and handles settle. */
  retireIdleSession(): Promise<void> {
    const session = this.currentSession;
    if (!session || session.activeInteractions > 0 || this.closed || this.failed) return Promise.resolve();
    this.currentSession = undefined;
    return this.retireSession(session) ?? Promise.resolve();
  }
  reference(session: TrafficDumpSession, interaction: number): ProviderProxyMetrics["traffic"] {
    return this.closed || this.failed ? undefined : { label: this.label, session: session.writerSession, interaction };
  }

  writeTrace(session: TrafficDumpSession, record: Record<string, unknown>): boolean {
    if (this.closed || this.failed) return false;
    const content = `${JSON.stringify({ ts: Date.now(), ...record })}\n`;
    const bytes = Buffer.byteLength(content);
    if (this.budget.traceBytes + bytes > maximumPendingTraceBytes || !this.hasCapacity(bytes, true)) {
      this.noticeCapacity("trace"); return false;
    }
    if (session.traceWrittenBytes > 0 && session.traceWrittenBytes + bytes > modelTrafficDumpFileSizeLimitBytes) {
      session.traceFileIndex++; session.traceWrittenBytes = 0;
    }
    if (!this.enqueue({ session, name: `trace-${session.traceFileIndex}.jsonl`, content, bytes, trace: true })) return false;
    session.traceWrittenBytes += bytes;
    return true;
  }
  writeInteraction(session: TrafficDumpSession, record: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    const content = `${JSON.stringify({ version: 2, ts: Date.now(), ...record })}\n`;
    this.enqueue({ session, name: "interactions.jsonl", content, bytes: Buffer.byteLength(content) });
  }
  writePayload(session: TrafficDumpSession, content: Buffer, encoding: "base64" | "utf8"): TrafficPayloadPart | undefined {
    if (this.closed || this.failed) return undefined;
    if (session.payloadWrittenBytes > 0 && session.payloadWrittenBytes + content.length > modelTrafficDumpFileSizeLimitBytes) {
      session.payloadFileIndex++; session.payloadWrittenBytes = 0;
    }
    const part = { bytes: content.length, encoding, file: `payload-${session.payloadFileIndex}.bin`, offset: session.payloadWrittenBytes };
    // Own a copy: callers may reuse their network Buffer as soon as forwarding continues.
    if (!this.hasCapacity(content.length, true)) {
      this.noticeCapacity("payload");
      return undefined;
    }
    if (!this.enqueue({ session, name: part.file, content: Buffer.from(content), bytes: content.length })) return undefined;
    session.payloadWrittenBytes += content.length;
    return part;
  }

  abort(): void { this.fail("shutdown", "cancelled"); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.currentSession = undefined;
    for (const session of this.state.sessions) void this.retireSession(session, true);
    this.closing = this.closeWithinBudget().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
  private async closeWithinBudget(): Promise<void> {
    // Maintenance is optional; stop it immediately while accepted writes drain.
    this.maintenanceAgain = false;
    this.maintenanceAbort.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => { await this.cleanupAfterWrites(); await this.maintenance; })(),
        new Promise<void>((_resolve, reject) => { timer = setTimeout(() => {
          this.abort(); reject(new Error("Traffic dump shutdown failed (timeout)"));
        }, operationBudgetMs); }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "Traffic dump shutdown failed (timeout)") throw error;
      // eslint-disable-next-line preserve-caught-error -- Raw OS causes include private paths; retain only the failure classification.
      throw new Error(`Traffic dump shutdown failed (${errorReason(error)})`);
    } finally { clearTimeout(timer); }
  }

  private ensureCurrentSession(startedAtMs: number, rotate: boolean): TrafficDumpSession {
    const current = this.currentSession;
    if (current && (!rotate || startedAtMs - current.startedAtMs < sessionRotationIntervalMs
      && current.acceptedBytes < (this.options.rotateAfterBytes ?? modelTrafficDumpFileSizeLimitBytes))) return current;
    // Allocate identity before any async work; collisions fail closed without rebinding published references.
    // Keep the existing timestamp/numeric-suffix contract used by Relay metrics admission.
    const nonce = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString(10);
    const writerSession = `${new Date(startedAtMs).toISOString().replace(/[:.]/gu, "-")}-${nonce}`;
    const session: TrafficDumpSession = { acceptedBytes: 0, activeInteractions: 0, closing: false, interactionCount: 0,
      payloadFileIndex: 1, payloadWrittenBytes: 0, sessionDirectory: join(this.options.directory, `${this.label}-${writerSession}`),
      startedAtMs, traceFileIndex: 1, traceWrittenBytes: 0, writerSession };
    if (!this.closed && !this.failed) {
      if (this.state.sessions.size >= maximumSessions) this.fail("session", "capacity");
      else {
        this.state.sessions.add(session); this.currentSession = session;
        this.protections.set(session, protectModelTrafficDumpSession(session.sessionDirectory));
      }
    }
    if (current) void this.retireSession(current);
    return session;
  }

  private hasCapacity(bytes: number, reserveIndex = false): boolean {
    return this.budget.items < maximumPendingItems - (reserveIndex ? reservedIndexItems : 0)
      && this.budget.bytes + bytes <= (this.options.maximumPendingBytes ?? maximumPendingBytes) - (reserveIndex ? reservedIndexBytes : 0);
  }
  private noticeCapacity(kind: "trace" | "payload"): void {
    if (this.capacityNotices.has(kind)) return;
    this.capacityNotices.add(kind);
    try { this.options.onCapacity(new Error(`Traffic dump ${kind} skipped (capacity)`)); } catch { /* Side channel. */ }
  }
  private enqueue(job: Job): boolean {
    if (this.failed) return false;
    // Reserve the immutable manifest with the first accepted write, including while it is pending.
    const manifestBytes = "name" in job && job.session.acceptedBytes === 0
      ? Buffer.byteLength(this.manifest(job.session)) : 0;
    if (!this.hasCapacity(job.bytes + manifestBytes)) { this.fail("queue", "capacity"); return false; }
    if ("name" in job) {
      job.manifestBytes = manifestBytes;
      job.bytes += manifestBytes;
      job.session.acceptedBytes += job.bytes;
    }
    this.budget.bytes += job.bytes; this.budget.items++;
    if ("trace" in job && job.trace) this.budget.traceBytes += job.bytes - (job.manifestBytes ?? 0);
    this.jobs.push(job);
    this.options.onBytesAccepted?.(job.bytes);
    this.startDrain();
    return true;
  }
  private startDrain(): void {
    if (this.running || this.failed || this.jobs.length === 0) return;
    // A completion microtask can enqueue after drain observes an empty queue.
    // Hand off ownership only after checking those newly accepted writes too.
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = undefined;
      this.startDrain();
    });
  }
  private release(job: Job): void {
    this.budget.bytes -= job.bytes; this.budget.items--;
    if ("trace" in job && job.trace) this.budget.traceBytes -= job.bytes - (job.manifestBytes ?? 0);
    if (this.budget.items === 0) this.capacityNotices.clear();
  }
  private async drain(): Promise<void> {
    while (this.jobs.length && !this.failed) {
      const job = this.jobs.shift()!;
      const timer = setTimeout(() => this.fail("write", "timeout"), operationBudgetMs);
      try {
        if ("name" in job) await this.write(job);
        else {
          await this.closeSessionFiles(job.session);
          this.state.sessions.delete(job.session);
          this.protections.get(job.session)?.(); this.protections.delete(job.session);
          this.finishRetirement(job.session);
          this.pruneSessions();
        }
      } catch (error) { if (!this.failed) this.fail("write", errorReason(error)); }
      finally { clearTimeout(timer); this.release(job); }
    }
  }
  private async write(job: WriteJob): Promise<void> {
    const signal = this.abortController.signal;
    signal.throwIfAborted();
    let resources = this.files.get(job.session);
    if (!resources) { resources = { prepared: false, files: new Map() }; this.files.set(job.session, resources); }
    if (!resources.prepared) {
      await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 }); signal.throwIfAborted();
      await securePrivateDirectory(this.options.directory, { signal }); signal.throwIfAborted();
      await fs.mkdir(job.session.sessionDirectory, { mode: 0o700 }); signal.throwIfAborted();
      await securePrivateDirectory(job.session.sessionDirectory, { signal }); signal.throwIfAborted();
      const manifestPath = join(job.session.sessionDirectory, "manifest.json");
      const manifest = this.manifest(job.session);
      const pendingPath = join(job.session.sessionDirectory, `.manifest-${randomUUID()}.pending`);
      try {
        // Finish both private access preparation and Runtime staging cleanup before
        // readers can discover the manifest. Published metadata stays immutable.
        await writePrivateFileAtomic(pendingPath, manifest, { signal });
        signal.throwIfAborted();
        try {
          await fs.lstat(manifestPath);
          throw Object.assign(new Error("Traffic dump manifest already exists"), { code: "EEXIST" });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        signal.throwIfAborted();
        // Exclusive session mkdir gives this writer sole ownership. This check
        // rejects existing objects; rename is not a same-user no-replace primitive.
        await fs.rename(pendingPath, manifestPath);
      } catch (error) {
        await fs.rm(pendingPath, { force: true });
        throw error;
      }
      signal.throwIfAborted();
      resources.prepared = true;
      this.pruneSessions();
    }
    let file = resources.files.get(job.name);
    if (!file) {
      // Exclusive creation prevents appending to a preexisting file even after an unexpected collision.
      const path = join(job.session.sessionDirectory, job.name);
      file = await fs.open(path, "wx", 0o600);
      resources.files.set(job.name, file);
      signal.throwIfAborted();
      await securePrivateFile(path, { signal }); signal.throwIfAborted();
      // Rotated files have no subsequent writers; close them before opening further generations.
      for (const [name, previous] of resources.files) {
        if (name !== job.name && name.split("-")[0] === job.name.split("-")[0]) {
          await previous.close(); resources.files.delete(name); signal.throwIfAborted();
        }
      }
    }
    signal.throwIfAborted();
    await file.writeFile(job.content);
    signal.throwIfAborted();
  }
  private manifest(session: TrafficDumpSession): string {
    return `${JSON.stringify({ createdAtMs: session.startedAtMs, label: this.label, session: session.writerSession, version: 2 }, null, 2)}\n`;
  }
  private retireSession(session: TrafficDumpSession, force = false): Promise<void> | undefined {
    if (session.closing) return this.retirements.get(session)?.promise;
    if (!force && session.activeInteractions > 0) return undefined;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.retirements.set(session, { promise, resolve });
    session.closing = true;
    this.enqueue({ session, bytes: 0 });
    return promise;
  }
  private finishRetirement(session: TrafficDumpSession): void {
    this.retirements.get(session)?.resolve();
    this.retirements.delete(session);
  }
  private async closeSessionFiles(session: TrafficDumpSession): Promise<void> {
    const resources = this.files.get(session);
    if (!resources) return;
    const results = await Promise.allSettled([...resources.files.values()].map(async file => {
      await file.close();
      for (const [name, owned] of resources.files) if (owned === file) resources.files.delete(name);
    }));
    if (results.some(result => result.status === "rejected")) throw new Error("Traffic dump file cleanup failed");
    this.files.delete(session);
  }
  private async closeFiles(): Promise<void> {
    const results = await Promise.allSettled([...this.files.keys()].map(session => this.closeSessionFiles(session)));
    if (results.some(result => result.status === "rejected")) throw new Error("Traffic dump session cleanup failed");
    for (const release of this.protections.values()) release();
    this.protections.clear(); this.state.sessions.clear();
    for (const session of this.retirements.keys()) this.finishRetirement(session);
  }
  private cleanupAfterWrites(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    const task = (async () => {
      while (this.running || (!this.failed && this.jobs.length > 0)) {
        this.startDrain();
        await this.running;
      }
      await this.closeFiles();
    })();
    this.cleanupTask = task;
    void task.then(() => { if (this.cleanupTask === task) this.cleanupTask = undefined; }, () => {
      if (this.cleanupTask === task) this.cleanupTask = undefined;
      try { this.options.onError(new Error("Traffic dump cleanup failed (io)")); } catch { /* Side channel. */ }
    });
    return task;
  }

  private readonly maintenanceAbort = new AbortController();
  private pruneSessions(): void {
    if (this.closed || this.failed || this.options.retentionManagedExternally) return;
    if (this.maintenance) { this.maintenanceAgain = true; return; }
    const signal = this.maintenanceAbort.signal;
    const timer = setTimeout(() => this.fail("maintenance", "timeout"), operationBudgetMs);
    this.maintenance = pruneModelTrafficDumpSessionsAsync({ directory: this.options.directory, label: this.label,
      retentionDays: this.options.retentionDays,
      isProtected: path => [...this.state.sessions].some(session => session.sessionDirectory === path),
    }, signal).then(() => undefined).catch(error => {
      if (!signal.aborted) this.fail("maintenance", errorReason(error));
    }).finally(() => {
      clearTimeout(timer); this.maintenance = undefined;
      if (this.maintenanceAgain) { this.maintenanceAgain = false; this.pruneSessions(); }
    });
  }
  private fail(operation: string, reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.abortController.abort(); this.maintenanceAbort.abort();
    for (const job of this.jobs.splice(0)) this.release(job);
    // Retain running ownership until late OS I/O settles and close handles acquired after cancellation.
    void this.cleanupAfterWrites();
    try { this.options.onError(new Error(`Traffic dump ${operation} failed (${reason})`)); } catch { /* Side channel. */ }
  }
}

function errorReason(error: unknown): string {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["EACCES", "EPERM", "ENOSPC", "EEXIST", "ENOENT", "EIO", "EROFS"].includes(code) ? code : "io";
}
