import { createHash, timingSafeEqual } from "node:crypto";

/** requestsPerMinute=0 disables only rate/burst admission, never concurrency. */
export interface RelayLimit { maxConcurrency: number; requestsPerMinute: number; burst: number }
export interface RelayCaller {
  callerId: string;
  keyId: string;
  credentialGeneration: number;
  secretSha256: string;
  enabled: boolean;
  provider: string;
  models: readonly string[];
  reasoning?: "passthrough" | "off";
}
type RetiredIdentity = Pick<RelayCaller, "callerId" | "keyId" | "credentialGeneration">;
export interface RelayPolicy extends RelayLimit {
  enabled: boolean;
  callers: readonly RelayCaller[];
  accounts: readonly { provider: string }[];
  retiredCallers?: readonly RetiredIdentity[];
}

export class RelayAdmissionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const maximumBodyBytes = 1024 * 1024;
const maximumPendingBytes = 16 * maximumBodyBytes;
interface Pending { bytes: number; ready?: { model: string; deadline: number; resolve(): void; reject(error: unknown): void }; timer?: NodeJS.Timeout }

interface Bucket { tokens: number; updated: number; active: number; limit: RelayLimit }
export interface RelayLease {
  readonly caller: Readonly<RelayCaller>;
  readonly signal: AbortSignal;
  /** Synchronous guard immediately before opening the upstream connection. */
  check(model?: string): void;
  cancel(): void;
  release(): void;
}

/** Owns identity and permits only; no files, provider credentials, network or persistence. */
export class RelayAdmission {
  private policy: RelayPolicy;
  private readonly budget: Bucket;
  private readonly leases = new Map<RelayLease, string>();
  private readonly revokedProviders = new Set<string>();
  private readonly identities = new Map<string, Readonly<RelayCaller>>();
  private retiredIdentities = new Map<string, RetiredIdentity>();
  private readonly failures: Bucket;
  private closed = false;
  private accepting = true;
  private readonly pending = new Map<RelayLease, Pending>();
  private pendingBytes = 0;
  private readonly pendingKeys = new Set<string>();
  private wakeTimer: NodeJS.Timeout | undefined;
  private scheduling = false;
  private timedOut = 0;

  constructor(policy: RelayPolicy, private readonly now: () => number = () => performance.now()) {
    this.policy = freezePolicy(policy);
    this.failures = { tokens: 8, updated: now(), active: 0, limit: { maxConcurrency: 64, requestsPerMinute: 60, burst: 8 } };
    this.budget = { tokens: policy.burst, active: 0, updated: now(), limit: this.policy };
    for (const caller of this.policy.callers) this.identities.set(caller.keyId, caller);
    this.retiredIdentities = retirementIndex(this.policy);
  }

  get active(): number { return this.leases.size - this.pending.size; }
  get queue(): { pending: number; waiting: number; bytes: number; oldestWaitMs: number; timedOut: number } {
    const waiting = [...this.pending.values()].flatMap(entry => entry.ready ? [entry.ready] : []);
    return { pending: this.pending.size, waiting: waiting.length, bytes: this.pendingBytes,
      oldestWaitMs: Math.floor(Math.max(0, ...waiting.map(entry => this.now() - (entry.deadline - 30_000)))), timedOut: this.timedOut };
  }

  /** Reserve bounded upload memory before reading any body; no execution credits yet. */
  reserve(authorization: string | undefined): RelayLease { return this.createLease(authorization, true); }
  acquire(authorization: string | undefined): RelayLease { return this.createLease(authorization, false); }

  /** Called once after bounded body validation. The caller owns body storage until completion. */
  wait(lease: RelayLease, model: string, bytes: number, signal: AbortSignal): Promise<void> {
    const entry = this.pending.get(lease);
    if (!entry || entry.ready) throw new RelayAdmissionError(503, "request_revoked");
    lease.check(model); signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumBodyBytes) throw new RelayAdmissionError(413, "request_too_large");
    this.pendingBytes -= entry.bytes - bytes; entry.bytes = bytes;
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => { entry.ready?.reject(signal.reason); lease.release(); };
      const finish = (error?: unknown): void => {
        signal.removeEventListener("abort", abort);
        if (error === undefined) resolve(); else reject(error instanceof Error ? error : new RelayAdmissionError(503, "request_revoked"));
      };
      entry.ready = { model, deadline: this.now() + 30_000, resolve: () => finish(), reject: error => finish(error) };
      signal.addEventListener("abort", abort, { once: true });
      entry.timer = setTimeout(() => {
        this.timedOut = Math.min(Number.MAX_SAFE_INTEGER, this.timedOut + 1);
        entry.ready?.reject(new RelayAdmissionError(429, "relay_queue_timeout")); lease.release();
      }, 30_000);
      this.schedule();
    });
  }

  /** Stop waiting immediately while allowing executing requests their shutdown grace. */
  stopWaiting(): void {
    this.accepting = false;
    for (const lease of [...this.pending.keys()]) lease.cancel();
    clearTimeout(this.wakeTimer); this.wakeTimer = undefined;
  }

  private createLease(authorization: string | undefined, deferred: boolean): RelayLease {
    if (!this.accepting || this.closed || !this.policy.enabled) throw new RelayAdmissionError(503, "relay_unavailable");
    refill(this.failures, this.now());
    if (this.failures.tokens < 1) throw new RelayAdmissionError(429, "authentication_rate_limited");
    const match = /^Bearer cr1\.([a-z0-9][a-z0-9_-]{0,63})\.([A-Za-z0-9_-]{43})$/u.exec(authorization ?? "");
    const caller = match ? this.policy.callers.find(value => value.keyId === match[1]) : undefined;
    const bytes = match ? Buffer.from(match[2]!, "base64url") : Buffer.alloc(32);
    const actual = createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(caller?.secretSha256 ?? "0".repeat(64), "hex");
    const valid = expected.length === actual.length && timingSafeEqual(actual, expected);
    if (!match || !caller || !caller.enabled || !valid || bytes.length !== 32 || bytes.toString("base64url") !== match[2]) {
      this.failures.tokens -= 1;
      throw new RelayAdmissionError(401, "invalid_api_key");
    }
    if (this.revokedProviders.has(caller.provider)) throw new RelayAdmissionError(503, "provider_unavailable");
    const account = this.policy.accounts.find(value => value.provider === caller.provider);
    if (!account) throw new RelayAdmissionError(503, "provider_unavailable");
    if (deferred) {
      if (this.pending.size >= 32 || this.pendingBytes + maximumBodyBytes > maximumPendingBytes) {
        throw new RelayAdmissionError(429, "relay_queue_full");
      }
    } else {
      if (this.delay() > 0) throw new RelayAdmissionError(429, "relay_rate_limited");
      this.debit();
    }
    const controller = new AbortController();
    const identity = privilege(caller);
    let released = false;
    const lease: RelayLease = {
      caller, signal: controller.signal,
      check: (model) => {
        if (released || controller.signal.aborted || this.closed || !this.policy.enabled) throw new RelayAdmissionError(503, "request_revoked");
        const current = this.policy.callers.find(value => value.keyId === caller.keyId);
        if (!current?.enabled || privilege(current) !== identity || this.revokedProviders.has(caller.provider)
          || !this.policy.accounts.some(value => value.provider === caller.provider)) throw new RelayAdmissionError(503, "request_revoked");
        if (model !== undefined && !current.models.includes(model)) throw new RelayAdmissionError(403, "model_not_allowed");
      },
      cancel: () => {
        controller.abort(new RelayAdmissionError(503, "request_revoked"));
        if (this.pending.has(lease)) lease.release();
      },
      release: () => {
        if (released) return;
        released = true; controller.abort(); this.leases.delete(lease);
        const entry = this.removePending(lease);
        if (entry) entry.ready?.reject(new RelayAdmissionError(503, "request_revoked"));
        else this.budget.active -= 1;
        this.schedule();
      },
    };
    this.leases.set(lease, identity);
    if (deferred) {
      this.pending.set(lease, { bytes: maximumBodyBytes }); this.pendingBytes += maximumBodyBytes;
      this.pendingKeys.add(caller.keyId);
    }
    return lease;
  }

  private removePending(lease: RelayLease): Pending | undefined {
    const entry = this.pending.get(lease);
    if (entry) {
      clearTimeout(entry.timer); this.pending.delete(lease); this.pendingBytes -= entry.bytes;
      if (![...this.pending.keys()].some(value => value.caller.keyId === lease.caller.keyId)) this.pendingKeys.delete(lease.caller.keyId);
    }
    return entry;
  }

  private debit(): void {
    if (this.budget.limit.requestsPerMinute > 0) this.budget.tokens -= 1;
    this.budget.active += 1;
  }
  private delay(): number {
    const bucket = this.budget;
    refill(bucket, this.now());
    if (bucket.active >= bucket.limit.maxConcurrency) return Infinity;
    return bucket.limit.requestsPerMinute > 0 && bucket.tokens < 1
      ? Math.ceil((1 - bucket.tokens) * 60_000 / bucket.limit.requestsPerMinute) : 0;
  }
  private schedule(): void {
    if (this.scheduling) return;
    clearTimeout(this.wakeTimer); this.wakeTimer = undefined;
    if (!this.accepting || this.closed || !this.policy.enabled) return;
    this.scheduling = true;
    try {
      let progressed: boolean;
      let nextWake: number;
      do {
        progressed = false; nextWake = Infinity;
        for (const key of [...this.pendingKeys]) {
          const lease = [...this.pending.keys()].find(value => value.caller.keyId === key);
          if (!lease) continue;
          const entry = this.pending.get(lease)!;
          // An incomplete upload cannot be overtaken by another request from this key.
          if (!entry.ready) continue;
          if (this.now() >= entry.ready.deadline) {
            this.timedOut = Math.min(Number.MAX_SAFE_INTEGER, this.timedOut + 1);
            entry.ready.reject(new RelayAdmissionError(429, "relay_queue_timeout")); lease.release(); progressed = true; continue;
          }
          try { lease.check(entry.ready.model); } catch { lease.cancel(); progressed = true; continue; }
          const delay = this.delay();
          if (delay > 0) { nextWake = Math.min(nextWake, delay); continue; }
          this.debit(); this.removePending(lease);
          // Preserve other keys' positions when this key drains or is cancelled.
          if (this.pendingKeys.delete(key)) this.pendingKeys.add(key);
          entry.ready.resolve(); progressed = true;
        }
      } while (progressed);
      if (Number.isFinite(nextWake)) this.wakeTimer = setTimeout(() => this.schedule(), Math.max(1, nextWake));
    } finally { this.scheduling = false; }
  }

  /** Caller passes a fully validated policy; publication and revocation are synchronous. */
  apply(policy: RelayPolicy): void {
    if (this.closed) throw new RelayAdmissionError(503, "relay_unavailable");
    const retired = retirementIndex(policy);
    for (const [key, prior] of this.retiredIdentities) {
      const next = retired.get(key);
      if (!next || next.callerId !== prior.callerId || next.credentialGeneration < prior.credentialGeneration) {
        this.failClosed(); throw new RelayAdmissionError(503, "credential_rollback_rejected");
      }
    }
    for (const caller of policy.callers) {
      const historical = retired.get(caller.keyId);
      if (historical && (historical.callerId !== caller.callerId || historical.credentialGeneration > caller.credentialGeneration)
        || this.retiredIdentities.has(caller.keyId) && !this.policy.callers.some(value => value.keyId === caller.keyId)
        || [...retired.values()].some(value => value.callerId === caller.callerId && value.keyId !== caller.keyId)) {
        this.failClosed(); throw new RelayAdmissionError(503, "credential_rollback_rejected");
      }
      const prior = this.identities.get(caller.keyId);
      if ([...this.identities.values()].some(value => value.callerId === caller.callerId && value.keyId !== caller.keyId)
        || prior && (prior.callerId !== caller.callerId || caller.credentialGeneration < prior.credentialGeneration
        || caller.credentialGeneration === prior.credentialGeneration && (caller.secretSha256 !== prior.secretSha256 || !prior.enabled && caller.enabled))) {
        this.failClosed(); throw new RelayAdmissionError(503, "credential_rollback_rejected");
      }
    }
    // Only discard old credential hashes once durable settlement identities cover them.
    const identities = new Map(this.identities);
    for (const [key, prior] of identities) {
      const historical = retired.get(key);
      if (!policy.callers.some(value => value.keyId === key) && historical?.callerId === prior.callerId
        && historical.credentialGeneration >= prior.credentialGeneration) identities.delete(key);
    }
    if (new Set([...identities.keys(), ...policy.callers.map(caller => caller.keyId)]).size > 256) {
      this.failClosed(); throw new RelayAdmissionError(503, "policy_capacity_exceeded");
    }
    this.policy = freezePolicy(policy);
    refill(this.budget, this.now()); this.budget.limit = this.policy; this.budget.tokens = Math.min(this.budget.tokens, policy.burst);
    this.retiredIdentities = retired;
    this.identities.clear();
    for (const [key, caller] of identities) this.identities.set(key, caller);
    for (const provider of this.revokedProviders) if (!policy.accounts.some(value => value.provider === provider)) this.revokedProviders.delete(provider);
    for (const [key, caller] of this.identities) if (!policy.callers.some(value => value.keyId === key)) this.identities.set(key, { ...caller, enabled: false });
    for (const caller of this.policy.callers) this.identities.set(caller.keyId, caller);
    for (const lease of this.leases.keys()) {
      try { lease.check(); } catch { lease.cancel(); }
    }
    this.schedule();
  }

  /** Material refresh owns when the account is safe to reopen. Old leases stay cancelled. */
  invalidateProvider(provider: string): void {
    if (!this.policy.accounts.some(account => account.provider === provider)) return;
    this.revokedProviders.add(provider);
    for (const lease of this.leases.keys()) if (lease.caller.provider === provider) lease.cancel();
  }
  restoreProvider(provider: string): void { if (!this.closed) this.revokedProviders.delete(provider); }
  failClosed(): void {
    clearTimeout(this.wakeTimer); this.wakeTimer = undefined;
    this.policy = { ...this.policy, enabled: false };
    for (const lease of this.leases.keys()) lease.cancel();
  }
  close(): void { this.closed = true; this.failClosed(); }
}

function refill(bucket: Bucket, now: number): void {
  const elapsed = Math.max(0, now - bucket.updated);
  bucket.tokens = Math.min(bucket.limit.burst, bucket.tokens + elapsed * bucket.limit.requestsPerMinute / 60_000);
  bucket.updated = Math.max(bucket.updated, now);
}
function privilege(caller: RelayCaller): string {
  return JSON.stringify([caller.callerId, caller.keyId, caller.credentialGeneration, caller.secretSha256,
    caller.provider, [...caller.models].sort(), caller.enabled, caller.reasoning ?? "passthrough"]);
}
function freezePolicy(policy: RelayPolicy): RelayPolicy {
  return Object.freeze({ ...policy,
    retiredCallers: Object.freeze((policy.retiredCallers ?? []).map(caller => Object.freeze({ ...caller }))),
    accounts: Object.freeze(policy.accounts.map(account => Object.freeze({ ...account }))),
    callers: Object.freeze(policy.callers.map(caller => Object.freeze({ ...caller, models: Object.freeze([...caller.models]) }))),
  });
}

function retirementIndex(policy: RelayPolicy): Map<string, RetiredIdentity> {
  const result = new Map<string, RetiredIdentity>();
  for (const caller of policy.retiredCallers ?? []) {
    if ((result.get(caller.keyId)?.credentialGeneration ?? 0) < caller.credentialGeneration) result.set(caller.keyId, Object.freeze({ ...caller }));
  }
  return result;
}
