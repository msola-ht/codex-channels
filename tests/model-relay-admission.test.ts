import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RelayAdmission, type RelayPolicy } from "../src/model-relay/index.js";

const secret = Buffer.alloc(32, 7);
const hash = createHash("sha256").update(secret).digest("hex");
const token = (key = "key-a"): string => `Bearer cr1.${key}.${secret.toString("base64url")}`;
const policy = (): RelayPolicy => ({ enabled: true, maxConcurrency: 8, requestsPerMinute: 60, burst: 8,
  accounts: [{ provider: "clp-a" }],
  callers: ["a", "b", "c"].map(id => ({ callerId: `caller-${id}`, keyId: `key-${id}`,
    credentialGeneration: 1, secretSha256: hash, enabled: true, provider: "clp-a", models: ["fixture/model"],
    })),
});

describe("Relay admission and revocation", () => {
  it("allows sustained requests without rate debits while enforcing ten concurrent global leases", () => {
    const base = policy();
    const config: RelayPolicy = { ...base, maxConcurrency: 10, requestsPerMinute: 0, burst: 1,
      accounts: base.accounts, callers: base.callers };
    const admission = new RelayAdmission(config, () => 0);
    for (let i = 0; i < 100; i++) admission.acquire(token()).release();
    const leases = Array.from({ length: 10 }, () => admission.acquire(token()));
    expect(() => admission.acquire(token())).toThrow("relay_rate_limited");
    leases.pop()!.release();
    const replacement = admission.acquire(token());
    [...leases, replacement].forEach(lease => lease.release());
    expect(admission.active).toBe(0);
  });
  it("can enable, disable and restore the global rate without resetting spent credits", () => {
    const unlimited: RelayPolicy = { ...policy(), requestsPerMinute: 0, burst: 1 };
    const limited = { ...unlimited, requestsPerMinute: 60 };
    let now = 0;
    const admission = new RelayAdmission(unlimited, () => now);
    for (let i = 0; i < 5; i++) admission.acquire(token()).release();
    admission.apply(limited);
    admission.acquire(token()).release();
    expect(() => admission.acquire(token())).toThrow("relay_rate_limited");
    admission.apply(unlimited);
    for (let i = 0; i < 5; i++) admission.acquire(token()).release();
    now = 10_000;
    admission.apply(limited);
    expect(() => admission.acquire(token())).toThrow("relay_rate_limited");
    now += 1000;
    admission.acquire(token()).release();
  });
  it("authenticates canonical secrets and enforces model permissions", () => {
    const admission = new RelayAdmission(policy());
    expect(() => admission.acquire(token().replace("Bearer", "Basic"))).toThrow("invalid_api_key");
    const lease = admission.acquire(token());
    expect(() => lease.check("other/model")).toThrow("model_not_allowed");
    lease.check("fixture/model"); lease.release(); lease.release();
    expect(admission.active).toBe(0);
    expect(() => lease.check()).toThrow("request_revoked");
  });
  it("holds global permits until release and preserves spent rate credits across keys", () => {
    const admission = new RelayAdmission({ ...policy(), maxConcurrency: 4, burst: 4 }, () => 0);
    const leases = [admission.acquire(token()), admission.acquire(token()), admission.acquire(token("key-b")), admission.acquire(token("key-b"))];
    expect(() => admission.acquire(token("key-c"))).toThrow("relay_rate_limited");
    leases.forEach(lease => lease.release());
    // Global rate was spent even after completion; rotating keys cannot bypass it.
    expect(() => admission.acquire(token("key-c"))).toThrow("relay_rate_limited");
    expect(admission.active).toBe(0);
  });
  it("does not restore rate credits on reload, rotation or a failed attempt", () => {
    let now = 0;
    const config = { ...policy(), burst: 2, requestsPerMinute: 10 }; const admission = new RelayAdmission(config, () => now);
    admission.acquire(token()).release(); admission.acquire(token()).release();
    admission.apply(config);
    expect(() => admission.acquire(token())).toThrow("relay_rate_limited");
    now = 6000;
    admission.acquire(token()).release();
    expect(() => admission.acquire(token())).toThrow("relay_rate_limited");
  });
  it("cancels old generations synchronously and cannot revive them after restore", () => {
    const config = policy(); const admission = new RelayAdmission(config);
    const lease = admission.acquire(token());
    admission.apply({ ...config, callers: config.callers.map(caller => ({ ...caller, credentialGeneration: 2 })) });
    expect(lease.signal.aborted).toBe(true);
    expect(() => admission.apply(config)).toThrow("credential_rollback_rejected");
    expect(() => admission.acquire(token())).toThrow("relay_unavailable");
    expect(() => lease.check()).toThrow("request_revoked");
    lease.release(); expect(admission.active).toBe(0);
  });
  it("invalidates account material and closes all active requests on invalid config", () => {
    const admission = new RelayAdmission(policy()); const lease = admission.acquire(token());
    admission.invalidateProvider("clp-a"); expect(lease.signal.aborted).toBe(true);
    expect(() => admission.acquire(token("key-b"))).toThrow("provider_unavailable");
    admission.restoreProvider("clp-a"); expect(() => lease.check()).toThrow("request_revoked");
    const other = admission.acquire(token("key-b"));
    admission.failClosed(); expect(other.signal.aborted).toBe(true);
    expect(() => admission.acquire(token("key-c"))).toThrow("relay_unavailable");
    lease.release(); other.release(); admission.close();
    expect(() => admission.apply(policy())).toThrow("relay_unavailable");
  });
  it("uses a single bounded failure bucket for arbitrary unknown keys", () => {
    const admission = new RelayAdmission(policy(), () => 0);
    for (let i = 0; i < 8; i++) expect(() => admission.acquire(token(`unknown-${i}`))).toThrow("invalid_api_key");
    expect(() => admission.acquire(token())).toThrow("authentication_rate_limited");
    expect(admission.active).toBe(0);
  });
});

const queuePolicy = (): RelayPolicy => {
  const base = policy();
  return { ...base, maxConcurrency: 1, requestsPerMinute: 0,
    accounts: base.accounts, callers: base.callers };
};

describe("Relay bounded waiting admission", () => {
  it("keeps same-key FIFO and rotates keys without debiting waiting requests", async () => {
    const admission = new RelayAdmission(queuePolicy());
    const active = admission.acquire(token());
    const a1 = admission.reserve(token()); const a2 = admission.reserve(token()); const b = admission.reserve(token("key-b"));
    const order: string[] = [];
    const wait = (lease: typeof a1, name: string) => admission.wait(lease, "fixture/model", 100, lease.signal).then(() => order.push(name));
    const promises = [wait(a1, "a1"), wait(a2, "a2"), wait(b, "b")];
    expect(admission.active).toBe(1); expect(admission.queue).toEqual({ pending: 3, waiting: 3, bytes: 300 });
    active.release(); await promises[0]; expect(order).toEqual(["a1"]);
    a1.release(); await promises[2]; expect(order).toEqual(["a1", "b"]);
    b.release(); await promises[1]; expect(order).toEqual(["a1", "b", "a2"]);
    a2.release(); expect(admission.queue.pending).toBe(0); expect(admission.active).toBe(0); admission.close();
  });
  it.each(["drained", "cancelled", "rejoined"])("preserves three-key rotation when a key is %s", async mode => {
    const admission = new RelayAdmission(queuePolicy());
    const active = admission.acquire(token());
    const order: string[] = []; const errors: string[] = [];
    const leases: ReturnType<RelayAdmission["reserve"]>[] = [];
    const waits: Promise<void>[] = [];
    const enqueue = (key: string, name: string) => {
      const lease = admission.reserve(token(key)); leases.push(lease);
      waits.push(admission.wait(lease, "fixture/model", 10, lease.signal).then(() => { order.push(name); },
        () => { errors.push(name); }));
      return lease;
    };
    const a1 = enqueue("key-a", "a1"); const a2 = enqueue("key-a", "a2");
    const b1 = enqueue("key-b", "b1"); const c1 = enqueue("key-c", "c1");
    try {
      active.release(); await Promise.resolve(); expect(order).toEqual(["a1"]);
      if (mode === "cancelled") b1.cancel();
      a1.release(); await Promise.resolve();
      let b2: typeof b1 | undefined;
      if (mode !== "cancelled") {
        expect(order).toEqual(["a1", "b1"]);
        if (mode === "rejoined") b2 = enqueue("key-b", "b2");
        b1.release(); await Promise.resolve();
      }
      const prefix = mode === "cancelled" ? ["a1"] : ["a1", "b1"];
      expect(order).toEqual([...prefix, "c1"]);
      c1.release(); await Promise.resolve(); expect(order).toEqual([...prefix, "c1", "a2"]);
      a2.release(); await Promise.resolve();
      if (b2) { expect(order).toEqual([...prefix, "c1", "a2", "b2"]); b2.release(); }
      expect(errors).toEqual(mode === "cancelled" ? ["b1"] : []);
      expect(admission.queue).toEqual({ pending: 0, waiting: 0, bytes: 0 }); expect(admission.active).toBe(0);
    } finally {
      admission.close(); active.release(); leases.forEach(lease => lease.release()); await Promise.all(waits);
    }
  });
  it("does not let later uploads overtake their key while other keys can execute", async () => {
    const base = queuePolicy();
    const admission = new RelayAdmission({ ...base, maxConcurrency: 3,
      accounts: [{ provider: "clp-a" }, { provider: "clp-b" }],
      callers: base.callers.map(caller => caller.keyId === "key-c" ? { ...caller, provider: "clp-b" } : caller) });
    const active = admission.acquire(token());
    const upload = admission.reserve(token("key-b"));
    const behind = admission.reserve(token("key-b"));
    const other = admission.reserve(token("key-c"));
    const behindWait = admission.wait(behind, "fixture/model", 20, behind.signal);
    await admission.wait(other, "fixture/model", 20, other.signal);
    expect(admission.active).toBe(2); expect(admission.queue.waiting).toBe(1);
    active.release(); expect(admission.queue.waiting).toBe(1);
    upload.release(); await behindWait;
    behind.release(); other.release(); admission.close();
  });
  it("bounds uploads by global reserved bytes without per-key quotas", () => {
    const admission = new RelayAdmission(queuePolicy());
    const leases = Array.from({ length: 16 }, () => admission.reserve(token()));
    expect(admission.queue.bytes).toBe(16 * 1024 * 1024);
    expect(() => admission.reserve(token("key-c"))).toThrow("relay_queue_full");
    leases.forEach(lease => lease.release()); expect(admission.queue.bytes).toBe(0); admission.close();
  });
  it("bounds total pending requests even when validated bodies are tiny", async () => {
    const base = queuePolicy();
    const admission = new RelayAdmission(base);
    const active = admission.acquire(token());
    const waits: Promise<void>[] = [];
    for (let i = 0; i < 32; i++) {
      const lease = admission.reserve(token());
      waits.push(admission.wait(lease, "fixture/model", 1, lease.signal).catch(() => {}));
    }
    expect(admission.queue).toEqual({ pending: 32, waiting: 32, bytes: 32 });
    expect(() => admission.reserve(token("key-b"))).toThrow("relay_queue_full");
    admission.close(); await Promise.all(waits); active.release(); expect(admission.queue.bytes).toBe(0);
  });
  it("removes disconnected waiters without consuming rate credits", async () => {
    const admission = new RelayAdmission(queuePolicy()); const active = admission.acquire(token());
    const lease = admission.reserve(token()); const controller = new AbortController();
    const result = admission.wait(lease, "fixture/model", 5, controller.signal);
    const rejection = expect(result).rejects.toThrow("client gone");
    controller.abort(new Error("client gone")); await rejection;
    expect(admission.queue.pending).toBe(0); expect(admission.active).toBe(1); active.release(); admission.close();
  });
  it.each(["rotation", "disabled", "model", "provider", "shutdown"])("cancels pending requests on %s", async change => {
    const config = queuePolicy(); const admission = new RelayAdmission(config); const active = admission.acquire(token());
    const lease = admission.reserve(token()); const rejection = expect(admission.wait(lease, "fixture/model", 5, lease.signal)).rejects.toThrow("request_revoked");
    if (change === "provider") admission.invalidateProvider("clp-a");
    else if (change === "shutdown") admission.stopWaiting();
    else admission.apply({ ...config, callers: config.callers.map(caller => ({ ...caller,
      ...(change === "rotation" ? { credentialGeneration: 2 } : change === "disabled" ? { enabled: false } : { models: [] }) })) });
    await rejection; expect(admission.queue.pending).toBe(0);
    if (change === "shutdown") expect(active.signal.aborted).toBe(false);
    active.release(); admission.close();
  });
  it("wakes on token refill and policy change, and times out without an upstream permit", async () => {
    vi.useFakeTimers();
    const config = queuePolicy(); const admission = new RelayAdmission({ ...config, requestsPerMinute: 60, burst: 1 }, () => Date.now());
    try {
      admission.acquire(token()).release();
      const lease = admission.reserve(token()); const waiting = admission.wait(lease, "fixture/model", 5, lease.signal);
      await vi.advanceTimersByTimeAsync(999); expect(admission.active).toBe(0);
      await vi.advanceTimersByTimeAsync(1); await waiting; expect(admission.active).toBe(1); lease.release();
      const next = admission.reserve(token()); const nextWait = admission.wait(next, "fixture/model", 5, next.signal);
      admission.apply(config); await nextWait;
      const timeout = admission.reserve(token());
      const rejection = expect(admission.wait(timeout, "fixture/model", 5, timeout.signal)).rejects.toThrow("relay_queue_timeout");
      await vi.advanceTimersByTimeAsync(30_000); await rejection;
      expect(admission.queue.pending).toBe(0); next.release(); expect(admission.active).toBe(0);
    } finally { admission.close(); vi.useRealTimers(); }
  });
});

it("honors reduced global concurrency and an expired deadline even before its timer callback", async () => {
  const config = { ...queuePolicy(), maxConcurrency: 2 }; let now = 0;
  const admission = new RelayAdmission(config, () => now);
  const a = admission.acquire(token()); const b = admission.acquire(token("key-b"));
  const lease = admission.reserve(token()); const rejected = expect(admission.wait(lease, "fixture/model", 1, lease.signal)).rejects.toThrow("relay_queue_timeout");
  admission.apply({ ...config, maxConcurrency: 1 }); a.release(); expect(admission.queue.waiting).toBe(1);
  now = 30_001; b.release(); await rejected;
  expect(admission.active).toBe(0); expect(admission.queue.pending).toBe(0); admission.close();
});

it("revokes only the key whose reasoning policy changed, including waiting leases", async () => {
  const initial = policy();
  const admission = new RelayAdmission({ ...initial, maxConcurrency: 1 });
  const active = admission.acquire(token());
  const sibling = admission.reserve(token("key-b"));
  const queued = admission.reserve(token());
  const waiting = admission.wait(queued, "fixture/model", 10, queued.signal);
  const rejected = expect(waiting).rejects.toThrow("request_revoked");
  admission.apply({ ...initial, maxConcurrency: 1, callers: initial.callers.map(caller => caller.keyId === "key-a" ? { ...caller, reasoning: "off" } : caller) });
  await rejected;
  expect(active.signal.aborted).toBe(true);
  expect(sibling.signal.aborted).toBe(false);
  expect(() => active.check()).toThrow("request_revoked");
  active.release(); sibling.release(); admission.close();
});
