import { describe, expect, it } from "vitest";
import { modelRelayConfigSchema, relayPolicyFromConfig } from "../runtime/model-relay-config.mjs";

const caller = { caller_id: "client", key_id: "key", credential_generation: 1, secret_sha256: "a".repeat(64),
  enabled: true, provider: "clp-example", models: ["fixture/model"] };
describe("Relay strict configuration", () => {
  it("defaults to disabled loopback and bounded limits without materializing identities", () => {
    const config = modelRelayConfigSchema.parse({});
    expect(config).toEqual({ enabled: false, host: "127.0.0.1", port: 4119, max_concurrency: 10, requests_per_minute: 0, burst: 10, callers: [], accounts: [] });
    expect(relayPolicyFromConfig(config).callers).toEqual([]);
  });
  it("projects already validated stable identities and exact account bindings", () => {
    const config = modelRelayConfigSchema.parse({ accounts: [{ provider: "clp-example" }], callers: [caller] });
    expect(config.accounts[0]).toMatchObject({ max_concurrency: 10, requests_per_minute: 0, burst: 10 });
    expect(config.callers[0]).toMatchObject({ max_concurrency: 10, requests_per_minute: 0, burst: 10 });
    expect(relayPolicyFromConfig(config).callers[0]).toMatchObject({ requestsPerMinute: 0, callerId: "client", keyId: "key", credentialGeneration: 1, provider: "clp-example" });
  });
  it("accepts translation limits above defaults and preserves all three scopes", () => {
    const config = modelRelayConfigSchema.parse({ enabled: true, max_concurrency: 32, requests_per_minute: 600, burst: 32,
      accounts: [{ provider: "clp-example", max_concurrency: 16, requests_per_minute: 300, burst: 16 }],
      callers: [{ ...caller, max_concurrency: 8, requests_per_minute: 120, burst: 8 }] });
    expect(relayPolicyFromConfig(config)).toMatchObject({ maxConcurrency: 32, requestsPerMinute: 600, burst: 32,
      accounts: [{ maxConcurrency: 16, requestsPerMinute: 300, burst: 16 }],
      callers: [{ maxConcurrency: 8, requestsPerMinute: 120, burst: 8 }] });
  });
  it.each(["global", "account", "caller"])("enforces bounded configurable limits at %s scope", scope => {
    for (const limits of [{ max_concurrency: 33 }, { requests_per_minute: -1 }, { requests_per_minute: 0.5 }, { requests_per_minute: 601 }, { burst: 33 }]) {
      const input = scope === "global" ? limits : scope === "account" ? { accounts: [{ provider: "clp-example", ...limits }] }
        : { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, ...limits }] };
      expect(modelRelayConfigSchema.safeParse(input).success).toBe(false);
    }
  });
  it.each([
    { host: "0.0.0.0" }, { host: "localhost" }, { port: 0 }, { allow_public: true }, { max_concurrency: 0 }, { burst: 33 },
    { callers: [caller] }, { accounts: [{ provider: "clp-example" }, { provider: "clp-example" }] },
    { accounts: [{ provider: "clp-example" }], callers: [caller, caller] },
    { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, credential_generation: Number.MAX_SAFE_INTEGER + 1 }] },
    { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, secret_sha256: "SECRET" }] },
    { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, models: ["same", "same"] }] },
    { accounts: [{ provider: "openai" }] },
  ])("rejects unsupported or unsafe configuration", value => {
    expect(modelRelayConfigSchema.safeParse(value).success).toBe(false);
  });
  it("keeps disabled tombstones after an account is removed", () => {
    expect(modelRelayConfigSchema.parse({ callers: [{ ...caller, enabled: false }] }).callers).toHaveLength(1);
  });
});
