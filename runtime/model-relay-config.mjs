import { z } from "zod";
import { createHash } from "node:crypto";

const identity = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const provider = z.string().regex(/^clp-[a-z0-9_-]{1,32}$/u);
const limits = (concurrency, burst) => ({
  max_concurrency: z.number().int().min(1).max(32).default(concurrency),
  requests_per_minute: z.number().int().min(0).max(600).default(0),
  burst: z.number().int().min(1).max(32).default(burst),
});
export const modelRelayConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(4119),
  ...limits(10, 10),
  accounts: z.array(z.strictObject({ provider, ...limits(10, 10) })).max(128).default([]),
  callers: z.array(z.strictObject({
    caller_id: identity,
    key_id: identity,
    credential_generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    secret_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    enabled: z.boolean(),
    provider,
    models: z.array(z.string().min(1).max(200).refine(value => ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))).min(1).max(64)
      .refine(values => new Set(values).size === values.length),
    ...limits(10, 10),
  })).max(128).default([]),
}).superRefine((value, context) => {
  for (const [values, key, path] of [[value.accounts, "provider", "accounts"],
    [value.callers, "caller_id", "callers"], [value.callers, "key_id", "callers"]]) {
    if (new Set(values.map(entry => entry[key])).size !== values.length) {
      context.addIssue({ code: "custom", path: [path], message: `Relay ${key} 必须唯一` });
    }
  }
  for (const [index, caller] of value.callers.entries()) {
    if (caller.enabled && !value.accounts.some(account => account.provider === caller.provider)) {
      context.addIssue({ code: "custom", path: ["callers", index, "provider"], message: "Relay 调用方必须引用已声明账户" });
    }
  }
});

/** Projection of already validated configuration; never loads provider credentials. */
export function relayPolicyFromConfig(config) {
  const limit = value => ({ maxConcurrency: value.max_concurrency, requestsPerMinute: value.requests_per_minute, burst: value.burst });
  return { enabled: config.enabled, ...limit(config),
    accounts: config.accounts.map(account => ({ provider: account.provider, ...limit(account) })),
    callers: config.callers.map(caller => ({ callerId: caller.caller_id, keyId: caller.key_id,
      credentialGeneration: caller.credential_generation, secretSha256: caller.secret_sha256,
      enabled: caller.enabled, provider: caller.provider, models: [...caller.models], ...limit(caller) })) };
}

export function modelRelayConfigDigest(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
