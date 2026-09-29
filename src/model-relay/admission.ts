import { createHash, timingSafeEqual } from "node:crypto";

export interface RelayLimit { maxConcurrency: number; requestsPerMinute: number; burst: number }
export interface RelayCaller extends RelayLimit {
  callerId: string;
  keyId: string;
  credentialGeneration: number;
  secretSha256: string;
  enabled: boolean;
  provider: string;
  models: readonly string[];
}
export interface RelayPolicy extends RelayLimit {
  enabled: boolean;
  callers: readonly RelayCaller[];
  accounts: readonly (RelayLimit & { provider: string })[];
}

export class RelayAdmissionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

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
  private readonly buckets = new Map<string, Bucket>();
  private readonly leases = new Map<RelayLease, string>();
  private readonly revokedProviders = new Set<string>();
  private readonly identities = new Map<string, Readonly<RelayCaller>>();
  private readonly failures: Bucket;
  private closed = false;

  constructor(policy: RelayPolicy, private readonly now: () => number = () => performance.now()) {
    this.policy = freezePolicy(policy);
    this.failures = { tokens: 8, updated: now(), active: 0, limit: { maxConcurrency: 64, requestsPerMinute: 60, burst: 8 } };
    this.configureBuckets();
    for (const caller of this.policy.callers) this.identities.set(caller.keyId, caller);
  }

  get active(): number { return this.leases.size; }

  acquire(authorization: string | undefined): RelayLease {
    if (this.closed || !this.policy.enabled) throw new RelayAdmissionError(503, "relay_unavailable");
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
    const scopes = ["global", `account:${caller.provider}`, `key:${caller.keyId}`].map(key => this.buckets.get(key)!);
    for (const bucket of scopes) {
      refill(bucket, this.now());
      if (bucket.active >= bucket.limit.maxConcurrency || bucket.tokens < 1) throw new RelayAdmissionError(429, "relay_rate_limited");
    }
    for (const bucket of scopes) { bucket.tokens -= 1; bucket.active += 1; }
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
      cancel: () => controller.abort(new RelayAdmissionError(503, "request_revoked")),
      release: () => {
        if (released) return;
        released = true; controller.abort(); this.leases.delete(lease);
        for (const bucket of scopes) bucket.active -= 1;
      },
    };
    this.leases.set(lease, identity);
    return lease;
  }

  /** Caller passes a fully validated policy; publication and revocation are synchronous. */
  apply(policy: RelayPolicy): void {
    if (this.closed) throw new RelayAdmissionError(503, "relay_unavailable");
    for (const caller of policy.callers) {
      const prior = this.identities.get(caller.keyId);
      if ([...this.identities.values()].some(value => value.callerId === caller.callerId && value.keyId !== caller.keyId)
        || prior && (prior.callerId !== caller.callerId || prior.provider !== caller.provider || caller.credentialGeneration < prior.credentialGeneration
        || caller.credentialGeneration === prior.credentialGeneration && (caller.secretSha256 !== prior.secretSha256 || !prior.enabled && caller.enabled))) {
        this.failClosed(); throw new RelayAdmissionError(503, "credential_rollback_rejected");
      }
    }
    this.policy = freezePolicy(policy);
    this.configureBuckets();
    for (const [key, caller] of this.identities) if (!policy.callers.some(value => value.keyId === key)) this.identities.set(key, { ...caller, enabled: false });
    for (const caller of this.policy.callers) this.identities.set(caller.keyId, caller);
    for (const lease of this.leases.keys()) {
      try { lease.check(); } catch { lease.cancel(); }
    }
  }

  /** Material refresh owns when the account is safe to reopen. Old leases stay cancelled. */
  invalidateProvider(provider: string): void {
    if (!this.policy.accounts.some(account => account.provider === provider)) return;
    this.revokedProviders.add(provider);
    for (const lease of this.leases.keys()) if (lease.caller.provider === provider) lease.cancel();
  }
  restoreProvider(provider: string): void { if (!this.closed) this.revokedProviders.delete(provider); }
  failClosed(): void {
    this.policy = { ...this.policy, enabled: false };
    for (const lease of this.leases.keys()) lease.cancel();
  }
  close(): void { this.closed = true; this.failClosed(); }

  private configureBuckets(): void {
    const entries: Array<readonly [string, RelayLimit]> = [["global", this.policy],
      ...this.policy.accounts.map(account => [`account:${account.provider}`, account] as const),
      ...this.policy.callers.map(caller => [`key:${caller.keyId}`, caller] as const)];
    // Removed scopes retain rate history. Refuse unbounded administrative churn.
    if (new Set([...this.buckets.keys(), ...entries.map(([key]) => key)]).size > 257) {
      this.failClosed(); throw new RelayAdmissionError(503, "policy_capacity_exceeded");
    }
    for (const [key, limit] of entries) {
      const existing = this.buckets.get(key);
      if (existing) {
        refill(existing, this.now()); existing.limit = limit; existing.tokens = Math.min(existing.tokens, limit.burst);
      } else this.buckets.set(key, { tokens: limit.burst, active: 0, updated: this.now(), limit });
    }
  }
}

function refill(bucket: Bucket, now: number): void {
  const elapsed = Math.max(0, now - bucket.updated);
  bucket.tokens = Math.min(bucket.limit.burst, bucket.tokens + elapsed * bucket.limit.requestsPerMinute / 60_000);
  bucket.updated = Math.max(bucket.updated, now);
}
function privilege(caller: RelayCaller): string {
  return JSON.stringify([caller.callerId, caller.keyId, caller.credentialGeneration, caller.secretSha256,
    caller.provider, [...caller.models].sort(), caller.enabled]);
}
function freezePolicy(policy: RelayPolicy): RelayPolicy {
  return Object.freeze({ ...policy,
    accounts: Object.freeze(policy.accounts.map(account => Object.freeze({ ...account }))),
    callers: Object.freeze(policy.callers.map(caller => Object.freeze({ ...caller, models: Object.freeze([...caller.models]) }))),
  });
}
