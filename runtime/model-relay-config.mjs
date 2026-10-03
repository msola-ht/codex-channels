import { parseRelayModelId } from "./model-relay-model-id.mjs";
import { isRelayListenHost } from "./model-relay-listen-host.mjs";
import { z } from "zod";
import { createHash } from "node:crypto";

const identity = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const relayDisplayNameSchema = z.string().refine(value => value.trim() === value && [...value].length >= 1 && [...value].length <= 64 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value), "用途名称须为 1–64 个字符，不含控制字符或首尾空白");
const provider = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const limits = (concurrency, burst) => ({
  max_concurrency: z.number().int().min(1).max(32).default(concurrency),
  requests_per_minute: z.number().int().min(0).max(600).default(0),
  burst: z.number().int().min(1).max(32).default(burst),
});
export const relayKeyModelsSchema = z.array(z.string().refine(value => parseRelayModelId(value) !== null)).min(1).max(256)
  .refine(values => new Set(values).size === values.length);
export const modelRelayConfigSchema = z.strictObject({
    enabled: z.boolean().default(false),
    host: z.string().refine(isRelayListenHost, "Relay 监听地址须为回环、IPv4 内网地址或 0.0.0.0").default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(4119),
    ...limits(10, 10),
    retired_callers: z.array(z.strictObject({ caller_id: identity, key_id: identity, provider,
      credential_generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })).max(4096).optional(),
    callers: z.array(z.strictObject({
      caller_id: identity,
      display_name: relayDisplayNameSchema.optional(),
      key_id: identity,
      credential_generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      secret_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      enabled: z.boolean(),
      reasoning: z.enum(["passthrough", "off"]).optional(),
      models: relayKeyModelsSchema,
    })).max(128).default([]),
  }).superRefine((value, context) => {
    for (const [values, key, path] of [[value.callers, "caller_id", "callers"], [value.callers, "key_id", "callers"]]) {
      if (new Set(values.map(entry => entry[key])).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: `Relay ${key} 必须唯一` });
      }
    }
    const retired = value.retired_callers ?? [];
    if (new Set(retired.map(entry => JSON.stringify([entry.caller_id, entry.key_id, entry.provider]))).size !== retired.length) {
      context.addIssue({ code: "custom", path: ["retired_callers"], message: "Relay 历史身份与提供商组合必须唯一" });
    }
    const callerKeys = new Map(), keyCallers = new Map();
    for (const entry of [...retired, ...value.callers]) {
      if (callerKeys.has(entry.caller_id) && callerKeys.get(entry.caller_id) !== entry.key_id
        || keyCallers.has(entry.key_id) && keyCallers.get(entry.key_id) !== entry.caller_id) {
        context.addIssue({ code: "custom", path: ["retired_callers"], message: "Relay 历史身份不能重新分配" });
      }
      callerKeys.set(entry.caller_id, entry.key_id); keyCallers.set(entry.key_id, entry.caller_id);
    }
  });

/** Projection of already validated configuration; never loads provider credentials. */
export function relayPolicyFromConfig(config) {
  const limit = value => ({ maxConcurrency: value.max_concurrency, requestsPerMinute: value.requests_per_minute, burst: value.burst });
  return { enabled: config.enabled, ...limit(config),
    retiredCallers: (config.retired_callers ?? []).map(({ caller_id, key_id, credential_generation }) =>
      ({ callerId: caller_id, keyId: key_id, credentialGeneration: credential_generation })),
    accounts: [...new Set(config.callers.flatMap(caller => caller.models.map(id => parseRelayModelId(id).provider)))].map(provider => ({ provider })),
    callers: config.callers.map(caller => ({ callerId: caller.caller_id, keyId: caller.key_id,
      credentialGeneration: caller.credential_generation, secretSha256: caller.secret_sha256,
      enabled: caller.enabled, models: [...caller.models], reasoning: caller.reasoning ?? "passthrough" })) };
}

export function modelRelayConfigDigest(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
