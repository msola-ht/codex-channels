import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  EncryptedFileCredentialRecordStore, MacKeychainCredentialRecordStore,
  WindowsDpapiCredentialRecordStore, type SecureCredentialRecordStore,
} from "../secure-credential-store.js";

interface Grant {
  id: string;
  msgId: string;
  actor: string;
  createdAt: number;
  sequence: number;
  state: "claimed" | "submitted" | "handled";
  thread?: string;
  turn?: string;
  generation: string;
}
interface Ledger { version: 1; appId: string; grants: Grant[] }
const windowMs = 5 * 60_000;
const maximumGrants = 500;

/** No bodies or URLs. A restarted writer never spends grants from an earlier lifetime. */
export class QqLedger {
  private readonly generation = randomUUID();
  private readonly startup = Date.now();
  private readonly deadlines = new Map<string, number>();
  private state: Ledger;
  private serial = Promise.resolve();
  private failed = false;
  constructor(private readonly records: SecureCredentialRecordStore, private readonly appId: string,
    private readonly onFailure: () => void = () => {}) {
    this.state = { version: 1, appId, grants: [] };
  }
  get available(): boolean { return !this.failed; }
  get unconfirmedCount(): number { return this.state.grants.filter(grant => grant.state === "claimed").length; }
  async open(): Promise<void> {
    const raw = await this.records.get(this.appId);
    if (raw === null) return;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error("QQ 传输登记损坏"); }
    if (!isRecord(data) || Object.keys(data).sort().join() !== "appId,grants,version"
      || data.version !== 1 || data.appId !== this.appId || !Array.isArray(data.grants)
      || data.grants.length > maximumGrants || !data.grants.every(validGrant)) {
      throw new Error("QQ 传输登记版本或内容无效");
    }
    this.state = data as unknown as Ledger;
  }
  claim(id: string, msgId: string, actor: string, createdAt: number): Promise<boolean> {
    return this.change(() => {
      const now = Date.now();
      // Timestamp is mandatory; no receive-time fallback can renew an old grant.
      if (createdAt <= this.startup || createdAt > now || now - createdAt >= windowMs) return false;
      this.state.grants = this.state.grants.filter(grant => now - grant.createdAt < windowMs);
      const retained = new Set(this.state.grants.map(grant => grant.id));
      for (const key of this.deadlines.keys()) if (!retained.has(key)) this.deadlines.delete(key);
      if (this.state.grants.some(grant => grant.id === id)) return false;
      if (this.state.grants.length >= maximumGrants) throw new Error("QQ 接收登记容量已满");
      this.state.grants.push({ id, msgId, actor, createdAt, sequence: 0, state: "claimed", generation: this.generation });
      // Keep the platform timestamp contract without allowing wall-clock rollback to renew it.
      const related = this.state.grants.filter(grant => grant.msgId === msgId && grant.actor === actor);
      this.deadlines.set(id, Math.min(performance.now() + Math.min(...related.map(grant => grant.createdAt)) + windowMs - now,
        ...related.flatMap(grant => this.deadlines.has(grant.id) ? [this.deadlines.get(grant.id)!] : [])));
      return true;
    });
  }
  associate(id: string, thread: string, turn: string, steered: boolean): Promise<void> {
    return this.change(() => {
      const grant = this.state.grants.find(value => value.id === id);
      if (!grant || grant.generation !== this.generation) throw new Error("QQ 回复来源已失效");
      grant.state = "submitted";
      // A steer is accepted input, never a replacement reply grant for the existing Turn.
      if (!steered) { grant.thread = thread; grant.turn = turn; }
    });
  }
  associateQueuedTurn(id: string, actor: string, thread: string, turn: string, assertAuthorized: () => void): Promise<void> {
    return this.change(() => {
      assertAuthorized();
      const { grant } = this.budget(id, actor);
      if (grant.thread !== undefined && (grant.thread !== thread || grant.turn !== turn)) {
        throw new Error("QQ 原回复来源已关联其他轮次");
      }
      grant.state = "submitted";
      grant.thread = thread;
      grant.turn = turn;
    });
  }
  forTurn(actor: string, thread: string, turn: string): string | undefined {
    // Keep the original grant; a later steer does not refresh an existing result's budget.
    return this.state.grants.find(grant => grant.actor === actor && grant.thread === thread
      && grant.turn === turn && grant.generation === this.generation)?.id;
  }
  handled(id: string): Promise<void> {
    return this.change(() => {
      const grant = this.state.grants.find(value => value.id === id);
      if (grant?.state === "claimed") grant.state = "handled";
    });
  }
  remaining(id: string, actor: string): number {
    const { used } = this.budget(id, actor);
    return 4 - used;
  }
  remainingMs(id: string, actor: string): number {
    return this.budget(id, actor).remainingMs;
  }
  private budget(id: string, actor: string): { grant: Grant; related: Grant[]; used: number; remainingMs: number } {
    if (this.failed) throw new Error("QQ 传输登记写入状态未知，请重启后核对");
    const grant = this.state.grants.find(value => value.id === id && value.actor === actor);
    if (!grant || grant.generation !== this.generation || Date.now() - grant.createdAt >= windowMs
      || grant.createdAt > Date.now()) throw new Error("QQ 回复窗口或额度不可用");
    const related = this.state.grants.filter(value => value.msgId === grant.msgId && value.actor === actor);
    // Every alias spends the same message window, including an earlier timestamp learned later.
    const deadline = Math.min(...related.filter(value => value.generation === this.generation)
      .map(value => this.deadlines.get(value.id) ?? 0));
    const remainingMs = Math.min(deadline - performance.now(),
      Math.min(...related.map(value => value.createdAt)) + windowMs - Date.now());
    if (remainingMs <= 0) throw new Error("QQ 回复窗口已过期");
    return { grant, related, used: Math.max(...related.map(value => value.sequence)), remainingMs };
  }
  reserve(id: string, actor: string, count = 1): Promise<{ msgId: string; msgSeq: number; expiresAt: number }> {
    return this.change(() => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new Error("QQ 回复分片数量无效");
      const { grant, related, used } = this.budget(id, actor);
      if (used + count > 4) throw new Error("QQ 回复额度不足以发送完整结果");
      for (const value of related) value.sequence = used + count;
      return { msgId: grant.msgId, msgSeq: used + 1, expiresAt: Math.min(...related.map(value => value.createdAt)) + windowMs };
    });
  }
  async close(): Promise<void> { await this.serial; }
  private change<T>(operation: () => T): Promise<T> {
    const task = this.serial.then(async () => {
      if (this.failed) throw new Error("QQ 传输登记写入状态未知，请重启后核对");
      const result = operation();
      try { await this.records.set(this.appId, JSON.stringify(this.state)); }
      catch { this.failed = true; this.onFailure(); throw new Error("QQ 传输登记写入失败"); }
      return result;
    });
    this.serial = task.then(() => {}, () => {});
    return task;
  }
}

export function createQqLedger(directory: string, appId: string, onFailure?: () => void): QqLedger {
  const records = process.platform === "darwin" ? new MacKeychainCredentialRecordStore("codexc-qq-transport-v1")
    : process.platform === "win32" ? new WindowsDpapiCredentialRecordStore(directory)
    : process.platform === "linux" ? new EncryptedFileCredentialRecordStore(directory) : undefined;
  if (!records) throw new Error("QQ 传输登记不支持当前平台");
  return new QqLedger(records, appId, onFailure);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validGrant(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some(key => !["id", "msgId", "actor", "createdAt", "sequence", "state", "thread", "turn", "generation"].includes(key))) return false;
  return [value.id, value.msgId, value.actor, value.generation].every(item => typeof item === "string" && item.length > 0 && item.length <= 256)
    && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) > 0
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0 && Number(value.sequence) <= 4
    && (value.state === "claimed" || value.state === "submitted" || value.state === "handled")
    && (value.thread === undefined || typeof value.thread === "string" && value.thread.length <= 256)
    && (value.turn === undefined || typeof value.turn === "string" && value.turn.length <= 256)
    && ((value.thread === undefined && value.turn === undefined)
      || typeof value.thread === "string" && typeof value.turn === "string");
}

interface ActiveLedger {
  version: 1;
  appId: string;
  clock: number;
  attempts: { actor: string; at: number }[];
  streams: { key: string; at: number; state: "started" | "done" }[];
}
const dayMs = 24 * 60 * 60_000;
const maximumActiveAttempts = 10_000;
const maximumStreams = 1_000;
const digest = (value: string): string => createHash("sha256").update(value).digest("base64url");
class QqRateWait extends Error {
  constructor(readonly milliseconds: number) { super("QQ 主动发送等待频率额度"); }
}
export interface QqActiveReservation { beforeSend(signal: AbortSignal): Promise<void> }

/** Independent transport accounting. Never contains text, attachments, credentials or conversation history. */
export class QqActiveLedger {
  private state: ActiveLedger;
  private serial = Promise.resolve();
  private failed = false;
  private readonly startedAt = Date.now();
  private readonly monotonicStart = performance.now();
  private nextRequest = 0;
  constructor(private readonly records: SecureCredentialRecordStore, private readonly appId: string,
    private readonly onFailure: () => void = () => {}) {
    this.state = { version: 1, appId, clock: 0, attempts: [], streams: [] };
  }
  get available(): boolean { return !this.failed; }
  async open(): Promise<void> {
    const raw = await this.records.get(this.appId);
    if (raw === null) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("QQ 主动发送登记损坏"); }
    if (!isRecord(value) || Object.keys(value).sort().join() !== "appId,attempts,clock,streams,version"
      || value.version !== 1 || value.appId !== this.appId || !Number.isSafeInteger(value.clock) || Number(value.clock) < 0
      || !Array.isArray(value.attempts) || value.attempts.length > maximumActiveAttempts
      || !value.attempts.every(entry => isRecord(entry) && Object.keys(entry).sort().join() === "actor,at"
        && typeof entry.actor === "string" && /^[\w-]{43}$/u.test(entry.actor)
        && Number.isSafeInteger(entry.at) && Number(entry.at) > 0 && Number(entry.at) <= Number(value.clock))
      || !Array.isArray(value.streams) || value.streams.length > maximumStreams
      || !value.streams.every(entry => isRecord(entry) && Object.keys(entry).sort().join() === "at,key,state"
        && typeof entry.key === "string" && /^[\w-]{43}$/u.test(entry.key)
        && Number.isSafeInteger(entry.at) && Number(entry.at) > 0 && Number(entry.at) <= Number(value.clock)
        && (entry.state === "started" || entry.state === "done"))) throw new Error("QQ 主动发送登记版本或内容无效");
    this.state = value as unknown as ActiveLedger;
    this.now();
  }
  private now(): number {
    const now = Date.now();
    if (now < this.state.clock || now + 1000 < this.startedAt + performance.now() - this.monotonicStart) {
      throw new Error("QQ 发送计次检测到系统时钟回退，拒绝恢复额度");
    }
    return now;
  }
  async reserve(actor: string, count: number, signal: AbortSignal): Promise<QqActiveReservation> {
    const entries: { actor: string; at: number }[] = [];
    await this.waitForRate(signal, () => this.change(now => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new Error("QQ 主动发送数量无效");
      const identity = digest(actor);
      this.state.attempts = this.state.attempts.filter(entry => entry.at > now - dayMs);
      const userDay = this.state.attempts.filter(entry => entry.actor === identity);
      if (this.state.attempts.length + count > maximumActiveAttempts) throw new Error("QQ 主动发送登记达到本地每日容量");
      if (userDay.length + count > 1000) throw new Error("QQ 主动发送达到每日接收额度，结果保留待核对");
      this.checkRate(identity, count, now);
      for (let index = 0; index < count; index++) {
        const entry = { actor: identity, at: now };
        this.state.attempts.push(entry);
        entries.push(entry);
      }
    }));
    let used = 0;
    return { beforeSend: async requestSignal => {
      const entry = entries[used];
      if (!entry) throw new Error("QQ 主动发送预留次数已耗尽");
      await this.waitForRate(requestSignal, () => this.change(now => {
        if (performance.now() < this.nextRequest) throw new QqRateWait(this.nextRequest - performance.now());
        // A token/upload wait must not turn older reservations into a burst at HTTP time.
        this.checkRate(entry.actor, 1, now, entry);
        if (entry.at <= now - dayMs || !this.state.attempts.includes(entry)) throw new Error("QQ 主动发送预留已过期");
        entry.at = now;
      }, () => { this.nextRequest = performance.now() + 250; }));
      used++;
    } };
  }
  private checkRate(actor: string, count: number, now: number, excluded?: { actor: string; at: number }): void {
    const windows = [
      { entries: this.state.attempts, period: 1000, limit: 5 },
      { entries: this.state.attempts, period: 60_000, limit: 30 },
      { entries: this.state.attempts.filter(entry => entry.actor === actor), period: 60_000, limit: 20 },
    ];
    for (const window of windows) {
      const entries = window.entries.filter(entry => entry !== excluded && entry.at > now - window.period).sort((left, right) => left.at - right.at);
      if (entries.length + count > window.limit) {
        throw new QqRateWait(entries[entries.length + count - window.limit - 1]!.at + window.period - now + 1);
      }
    }
  }
  private async waitForRate(signal: AbortSignal, operation: () => Promise<void>): Promise<void> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(65_000)]);
    while (true) {
      bounded.throwIfAborted();
      try { await operation(); return; }
      catch (error) {
        if (!(error instanceof QqRateWait)) throw error;
        await delay(Math.max(1, Math.ceil(error.milliseconds)), undefined, { signal: bounded });
      }
    }
  }
  hasStream(key: string): boolean { return this.state.streams.some(entry => entry.key === digest(key)); }
  startStream(key: string): Promise<void> {
    return this.change(now => {
      this.state.streams = this.state.streams.filter(entry => entry.at > now - dayMs);
      if (this.hasStream(key)) throw new Error("QQ 原生流已有发送登记，不重复发送");
      // Do not evict unknown or completed streams to make room for another send.
      if (this.state.streams.length >= maximumStreams) throw new Error("QQ 原生流登记容量已满");
      this.state.streams.push({ key: digest(key), at: now, state: "started" });
    });
  }
  completeStream(key: string): Promise<void> {
    return this.change(() => {
      const entry = this.state.streams.find(value => value.key === digest(key));
      if (!entry) throw new Error("QQ 原生流发送登记缺失");
      entry.state = "done";
    });
  }
  async close(): Promise<void> { await this.serial; }
  private change(operation: (now: number) => void, afterWrite?: () => void): Promise<void> {
    const task = this.serial.then(async () => {
      if (this.failed) throw new Error("QQ 主动发送登记不可用");
      const now = this.now();
      // Rejected operations can still prune expired entries. Retain their time
      // high-water mark so a later rollback cannot reuse those removed counts.
      this.state.clock = now;
      operation(now);
      const encoded = JSON.stringify(this.state);
      if (Buffer.byteLength(encoded, "utf8") > 950_000) throw new Error("QQ 主动发送登记达到安全存储容量");
      try { await this.records.set(this.appId, encoded); }
      catch { this.failed = true; this.onFailure(); throw new Error("QQ 主动发送登记写入失败"); }
      afterWrite?.();
    });
    this.serial = task.catch(() => {});
    return task;
  }
}

export function createQqActiveLedger(directory: string, appId: string, onFailure?: () => void): QqActiveLedger {
  const records = process.platform === "darwin" ? new MacKeychainCredentialRecordStore("codexc-qq-active-transport-v1")
    : process.platform === "win32" ? new WindowsDpapiCredentialRecordStore(join(directory, "active-v1"))
    : process.platform === "linux" ? new EncryptedFileCredentialRecordStore(join(directory, "active-v1")) : undefined;
  if (!records) throw new Error("QQ 主动发送登记不支持当前平台");
  return new QqActiveLedger(records, appId, onFailure);
}
