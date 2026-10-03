import { expect, it } from "vitest";
import { modelRelayConfigSchema, relayPolicyFromConfig } from "../runtime/model-relay-config.mjs";
import { parseRelayModelId, relayModelId } from "../runtime/model-relay-model-id.mjs";
const caller = { caller_id: "client", key_id: "key", credential_generation: 1, secret_sha256: "a".repeat(64), enabled: true,
  models: ["clp-example/deepseek-v4.1-flash", "rs-main/gpt-test"] };
it("defaults to bounded disabled service and derives providers only from exact Key grants", () => {
  expect(modelRelayConfigSchema.parse({})).toEqual({ enabled: false, host: "127.0.0.1", port: 4119, max_concurrency: 10, requests_per_minute: 0, burst: 10, callers: [] });
  const config = modelRelayConfigSchema.parse({ callers: [caller] });
  expect(relayPolicyFromConfig(config)).toMatchObject({ accounts: [{ provider: "clp-example" }, { provider: "rs-main" }],
    callers: [{ models: caller.models, reasoning: "passthrough" }] });
});
it("rejects removed formats, implicit model IDs, duplicates and unbounded permissions", () => {
  for (const patch of [{ accounts: [] }, { traffic_dump: false }, { unknown: true }, { max_concurrency: 33 }, { requests_per_minute: -1 }, { burst: 33 }]) {
    expect(modelRelayConfigSchema.safeParse(patch).success).toBe(false);
  }
  for (const patch of [{ provider: "clp-example" }, { models: [] }, { models: ["gpt-test"] }, { models: ["rs-main/gpt-test", "rs-main/gpt-test"] },
    { models: ["rs-main/"] }, { models: Array.from({ length: 257 }, (_, i) => `rs-main/m${i}`) }, { max_concurrency: 10 }, { reasoning: "high" }, { secret_sha256: "secret" }]) {
    expect(modelRelayConfigSchema.safeParse({ callers: [{ ...caller, ...patch }] }).success).toBe(false);
  }
  expect(modelRelayConfigSchema.safeParse({ callers: [caller, caller] }).success).toBe(false);
});
it("preserves wire IDs and strips only the CLP prefix when presenting model names", () => {
  expect(relayModelId("clp-main", "cline-pass/deepseek-v4.1-flash")).toBe("clp-main/deepseek-v4.1-flash");
  expect(relayModelId("rs-main", "vendor/model")).toBe("rs-main/vendor/model");
  expect(relayModelId("rs-main", "cline-pass/model")).toBe("rs-main/cline-pass/model");
  expect(parseRelayModelId("rs-main/vendor/model")).toEqual({ provider: "rs-main", model: "vendor/model" });
  for (const value of [null, "model", "/model", "rs-main/", "rs-main/ x", "rs-main/x\n", `rs-main/${"x".repeat(201)}`]) expect(parseRelayModelId(value)).toBeNull();
});

it("accepts Unicode display names without changing authorization policy and rejects unsafe names", () => {
  const base = modelRelayConfigSchema.parse({ callers: [caller] });
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


it("allows explicit private IPv4 listeners and rejects noncanonical, public and DNS hosts", () => {
  for (const host of ["127.0.0.1", "::1", "0.0.0.0", "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.1.10"]) {
    expect(modelRelayConfigSchema.parse({ host }).host).toBe(host);
  }
  for (const host of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "8.8.8.8", "100.64.0.1", "169.254.1.1", "::", "fd00::1", "::ffff:192.168.1.1", "localhost", "10.01.1.1", "10.1", "0", "0x0a000001", " 10.0.0.1", "http://192.168.1.1", "192.168.1.1:4119"]) {
    expect(modelRelayConfigSchema.safeParse({ host }).success, host).toBe(false);
  }
});
