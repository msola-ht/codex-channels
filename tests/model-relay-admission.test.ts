import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RelayAdmission, type RelayPolicy } from "../src/model-relay/index.js";

const secret = Buffer.alloc(32, 7);
const hash = createHash("sha256").update(secret).digest("hex");
const token = (key = "key-a"): string => `Bearer cr1.${key}.${secret.toString("base64url")}`;
const policy = (): RelayPolicy => ({ enabled: true, maxConcurrency: 8, requestsPerMinute: 60, burst: 8,
  accounts: [{ provider: "clp-a", maxConcurrency: 4, requestsPerMinute: 30, burst: 4 }],
  callers: ["a", "b", "c"].map(id => ({ callerId: `caller-${id}`, keyId: `key-${id}`,
    credentialGeneration: 1, secretSha256: hash, enabled: true, provider: "clp-a", models: ["fixture/model"],
    maxConcurrency: 2, requestsPerMinute: 10, burst: 2 })),
});

describe("Relay admission and revocation", () => {
  it("allows sustained requests without rate debits while enforcing ten concurrent global leases", () => {
    const base = policy();
    const config: RelayPolicy = { ...base, maxConcurrency: 10, requestsPerMinute: 0, burst: 1,
      accounts: base.accounts.map(value => ({ ...value, maxConcurrency: 32, requestsPerMinute: 0, burst: 1 })),
      callers: base.callers.map(value => ({ ...value, maxConcurrency: 32, requestsPerMinute: 0, burst: 1 })) };
    const admission = new RelayAdmission(config, () => 0);
    for (let i = 0; i < 100; i++) admission.acquire(token()).release();
    const leases = Array.from({ length: 10 }, () => admission.acquire(token()));
    expect(() => admission.acquire(token())).toThrow("relay_rate_limited");
    leases.pop()!.release();
    const replacement = admission.acquire(token());
    [...leases, replacement].forEach(lease => lease.release());
    expect(admission.active).toBe(0);
  });
  it.each(["global", "account", "key"])("can enable, disable and restore the %s rate limit without resetting spent credits", scope => {
    const base = policy();
    const unlimited: RelayPolicy = { ...base, requestsPerMinute: 0, burst: 1,
      accounts: base.accounts.map(value => ({ ...value, requestsPerMinute: 0, burst: 1 })),
      callers: base.callers.map(value => ({ ...value, requestsPerMinute: 0, burst: 1 })) };
    const limited = structuredClone(unlimited);
    if (scope === "global") limited.requestsPerMinute = 60;
    else if (scope === "account") limited.accounts[0]!.requestsPerMinute = 60;
    else limited.callers[0]!.requestsPerMinute = 60;
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
  it("reserves all three scopes without partial debit and holds permits until release", () => {
    const admission = new RelayAdmission(policy(), () => 0);
    const leases = [admission.acquire(token()), admission.acquire(token()), admission.acquire(token("key-b")), admission.acquire(token("key-b"))];
    expect(() => admission.acquire(token("key-c"))).toThrow("relay_rate_limited");
    leases.forEach(lease => lease.release());
    // Account rate was spent even after completion; rotating keys cannot bypass it.
    expect(() => admission.acquire(token("key-c"))).toThrow("relay_rate_limited");
    expect(admission.active).toBe(0);
  });
  it("does not restore rate credits on reload, rotation or a failed attempt", () => {
    let now = 0;
    const config = policy(); const admission = new RelayAdmission(config, () => now);
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
