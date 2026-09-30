import { describe, expect, it } from "vitest";
import { modelRelayConfigSchema, relayPolicyFromConfig, removeLegacyRelayCapture, upgradeModelRelayLimits } from "../runtime/model-relay-config.mjs";

const caller = { caller_id: "client", key_id: "key", credential_generation: 1, secret_sha256: "a".repeat(64),
  enabled: true, provider: "clp-example", models: ["fixture/model"] };
describe("Relay strict configuration", () => {
  it("defaults to disabled loopback and bounded limits without materializing identities", () => {
    const config = modelRelayConfigSchema.parse({});
    expect(config).toEqual({ enabled: false, host: "127.0.0.1", port: 4119, max_concurrency: 10, requests_per_minute: 0, burst: 10, callers: [], accounts: [] });
    expect(relayPolicyFromConfig(config).callers).toEqual([]);
  });
  it("rejects independent capture at runtime but validates it for explicit removal", () => {
    const base = { accounts: [{ provider: "clp-example" }], callers: [caller] };
    for (const patch of [{}, { traffic_dump: false }, { traffic_dump: true },
      { traffic_dump: true, traffic_dump_mode: "debug", traffic_dump_debug: { caller_id: "client", expires_at_ms: 2000 } }]) {
      expect(removeLegacyRelayCapture({ ...base, ...patch })).toEqual(base);
      if (Object.keys(patch).length) expect(modelRelayConfigSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
    for (const patch of [{ traffic_dump_mode: "debug" }, { traffic_dump_debug: { caller_id: "client", expires_at_ms: 2000 } },
      { traffic_dump: "yes" }, { unknown: true }]) expect(() => removeLegacyRelayCapture({ ...base, ...patch })).toThrow();
  });
  it("projects already validated stable identities and exact account bindings", () => {
    const config = modelRelayConfigSchema.parse({ accounts: [{ provider: "clp-example" }], callers: [caller] });
    expect(config.accounts[0]).toEqual({ provider: "clp-example" });
    expect(config.callers[0]).toEqual(caller);
    expect(relayPolicyFromConfig(config).callers[0]).toMatchObject({ callerId: "client", keyId: "key", credentialGeneration: 1, provider: "clp-example" });
  });
  it("accepts only global limits and explicitly upgrades the old per-account/key fields", () => {
    const legacy = { enabled: true, max_concurrency: 16, requests_per_minute: 80, burst: 12,
      accounts: [{ provider: "clp-example", max_concurrency: 8, requests_per_minute: 30, burst: 4 }],
      callers: [{ ...caller, max_concurrency: 2, requests_per_minute: 10, burst: 2 }] };
    expect(modelRelayConfigSchema.safeParse(legacy).success).toBe(false);
    const upgraded = upgradeModelRelayLimits(legacy);
    expect(upgraded).toMatchObject({ max_concurrency: 16, requests_per_minute: 80, burst: 12 });
    expect(upgraded.accounts).toEqual([{ provider: "clp-example" }]); expect(upgraded.callers).toEqual([caller]);
    expect(relayPolicyFromConfig(upgraded).callers[0]).not.toHaveProperty("maxConcurrency");
    expect(() => upgradeModelRelayLimits({ ...legacy, callers: [{ ...legacy.callers[0], unknown: 1 }] })).toThrow();
    expect(() => upgradeModelRelayLimits({ ...legacy, accounts: [{ provider: "clp-example", max_concurrency: 0 }] })).toThrow();
  });
  it("bounds global limits and rejects removed fields even at their former defaults", () => {
    for (const limits of [{ max_concurrency: 33 }, { requests_per_minute: -1 }, { requests_per_minute: 0.5 }, { requests_per_minute: 601 }, { burst: 33 }]) {
      expect(modelRelayConfigSchema.safeParse(limits).success).toBe(false);
    }
    for (const field of ["max_concurrency", "requests_per_minute", "burst"]) {
      expect(modelRelayConfigSchema.safeParse({ accounts: [{ provider: "clp-example", [field]: 10 }] }).success).toBe(false);
      expect(modelRelayConfigSchema.safeParse({ accounts: [{ provider: "clp-example" }], callers: [{ ...caller, [field]: 10 }] }).success).toBe(false);
    }
  });
  it.each([
    { host: "0.0.0.0" }, { host: "localhost" }, { port: 0 }, { allow_public: true }, { max_concurrency: 0 }, { burst: 33 },
    { callers: [caller] }, { accounts: [{ provider: "clp-example" }, { provider: "clp-example" }] },
    { accounts: [{ provider: "clp-example" }], callers: [caller, caller] },
    { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, credential_generation: Number.MAX_SAFE_INTEGER + 1 }] },
    { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, secret_sha256: "SECRET" }] },
    { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, models: ["same", "same"] }] },
    { accounts: [{ provider: "invalid/provider" }] },
  ])("rejects unsupported or unsafe configuration", value => {
    expect(modelRelayConfigSchema.safeParse(value).success).toBe(false);
  });
  it("keeps disabled tombstones after an account is removed", () => {
    expect(modelRelayConfigSchema.parse({ callers: [{ ...caller, enabled: false }] }).callers).toHaveLength(1);
  });
});

it("supports optional reasoning only for exact known provider/model pairs", () => {
  const value = { accounts: [{ provider: "clp-example" }], callers: [{ ...caller, reasoning: "off", models: ["cline-pass/deepseek-v4.1-flash"] }] };
  expect(relayPolicyFromConfig(modelRelayConfigSchema.parse(value)).callers[0]?.reasoning).toBe("off");
  expect(modelRelayConfigSchema.safeParse({ ...value, callers: [{ ...value.callers[0], models: ["unknown"] }] }).success).toBe(false);
  expect(modelRelayConfigSchema.safeParse({ ...value, callers: [{ ...value.callers[0], reasoning: "auto" }] }).success).toBe(false);
});

it("accepts Unicode display names without changing authorization policy and rejects unsafe names", () => {
  const base = modelRelayConfigSchema.parse({ accounts: [{ provider: caller.provider }], callers: [caller] });
  for (const name of ["沉浸式翻译", "翻".repeat(64), "Reader 2"]) {
    const named = modelRelayConfigSchema.parse({ ...base, callers: [{ ...caller, display_name: name }] });
    expect(named.callers[0]?.display_name).toBe(name);
    expect(relayPolicyFromConfig(named)).toEqual(relayPolicyFromConfig(base));
  }
  for (const name of ["", " ", " 名称", "名称 ", "翻".repeat(65), "a\nb", "a\u202eb"]) {
    expect(modelRelayConfigSchema.safeParse({ ...base, callers: [{ ...caller, display_name: name }] }).success).toBe(false);
  }
});

it("keeps retired settlement identities bounded, strict and outside admission policy", () => {
  const retired = { caller_id: "old", key_id: "old-key", provider: "clp-example", credential_generation: 1 };
  const config = modelRelayConfigSchema.parse({ retired_callers: [retired] });
  expect(relayPolicyFromConfig(config).callers).toEqual([]);
  expect(modelRelayConfigSchema.parse({})).not.toHaveProperty("retired_callers");
  for (const values of [[retired, retired], [{ ...retired, secret_sha256: "a".repeat(64) }],
    [{ ...retired, credential_generation: 0 }], [retired, { ...retired, key_id: "other", provider: "clp-other" }],
    Array.from({ length: 4097 }, (_, i) => ({ ...retired, caller_id: `c${i}`, key_id: `k${i}` }))]) {
    expect(modelRelayConfigSchema.safeParse({ retired_callers: values }).success).toBe(false);
  }
});
