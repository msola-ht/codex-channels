import { describe, expect, it } from "vitest";
import { modelRelayConfigSchema, relayPolicyFromConfig } from "../runtime/model-relay-config.mjs";

const caller = { caller_id: "client", key_id: "key", credential_generation: 1, secret_sha256: "a".repeat(64),
  enabled: true, provider: "clp-example", models: ["fixture/model"] };
describe("Relay strict configuration", () => {
  it("defaults to disabled loopback and bounded limits without materializing identities", () => {
    const config = modelRelayConfigSchema.parse({});
    expect(config).toEqual({ enabled: false, host: "127.0.0.1", port: 4119, max_concurrency: 8, requests_per_minute: 60, burst: 8, callers: [], accounts: [] });
    expect(relayPolicyFromConfig(config).callers).toEqual([]);
  });
  it("projects already validated stable identities and exact account bindings", () => {
    const config = modelRelayConfigSchema.parse({ accounts: [{ provider: "clp-example" }], callers: [caller] });
    expect(relayPolicyFromConfig(config).callers[0]).toMatchObject({ callerId: "client", keyId: "key", credentialGeneration: 1, provider: "clp-example" });
  });
  it.each([
    { host: "0.0.0.0" }, { host: "localhost" }, { port: 0 }, { allow_public: true }, { max_concurrency: 0 }, { burst: 9 },
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
