import { randomUUID } from "node:crypto";
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
