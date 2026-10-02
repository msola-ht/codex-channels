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
const modelId = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const relayExtraModelSchema = z.strictObject({
  id: modelId,
  reasoning_efforts: z.array(effort).max(7).refine(values => new Set(values).size === values.length),
  reasoning: z.enum(["passthrough", ...effort.options]),
}).superRefine((value, context) => {
  if (value.reasoning !== "passthrough" && !value.reasoning_efforts.includes(value.reasoning)) {
    context.addIssue({ code: "custom", path: ["reasoning"], message: "思考策略必须属于显式声明的支持等级" });
  }
});
export const relayExtraModelsSchema = z.array(relayExtraModelSchema).max(64)
  .refine(values => new Set(values.map(value => value.id)).size === values.length);
const enabledModels = z.array(modelId).max(256).refine(values => new Set(values).size === values.length);
function schema(legacy, legacyCapture = false, legacyModels = false) {
  return z.strictObject({
    enabled: z.boolean().default(false),
    ...(legacyCapture ? {
      traffic_dump: z.boolean().default(false),
      traffic_dump_mode: z.enum(["production", "debug"]).default("production"),
      traffic_dump_debug: z.strictObject({ caller_id: identity, expires_at_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
    } : {}),
    host: z.string().refine(isRelayListenHost, "Relay 监听地址须为回环、IPv4 内网地址或 0.0.0.0").default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(4119),
    ...limits(10, 10),
    accounts: z.array(z.strictObject({ provider, ...(legacyModels ? {} : { models: enabledModels.default([]) }), extra_models: relayExtraModelsSchema.optional(), ...(legacy ? limits(10, 10) : {}) })).max(128).default([]),
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
      provider,
      ...(legacyModels ? { models: z.array(z.string().min(1).max(200).refine(value => ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))).min(1).max(64)
        .refine(values => new Set(values).size === values.length) } : {}),
      ...(legacy ? limits(10, 10) : {}),
    })).max(128).default([]),
  }).superRefine((value, context) => {
    if (legacyCapture && (value.traffic_dump_mode === "debug" ? !value.traffic_dump || !value.traffic_dump_debug || !value.callers.some(caller => caller.caller_id === value.traffic_dump_debug.caller_id)
      : value.traffic_dump_debug !== undefined)) {
      context.addIssue({ code: "custom", path: ["traffic_dump_debug"], message: "Relay 调试采集必须启用、指定已存在调用方和截止时间；生产模式不接受调试表" });
    }
    for (const [values, key, path] of [[value.accounts, "provider", "accounts"],
      [value.callers, "caller_id", "callers"], [value.callers, "key_id", "callers"]]) {
      if (new Set(values.map(entry => entry[key])).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: `Relay ${key} 必须唯一` });
      }
    }
    for (const [index, account] of value.accounts.entries()) {
      if (account.extra_models !== undefined && !/^clp-[a-z0-9_-]{1,32}$/u.test(account.provider)) {
        context.addIssue({ code: "custom", path: ["accounts", index, "extra_models"], message: "额外模型仅支持 CLP 账户" });
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
    for (const [index, caller] of value.callers.entries()) {
      if (caller.enabled && !value.accounts.some(account => account.provider === caller.provider)) {
        context.addIssue({ code: "custom", path: ["callers", index, "provider"], message: "Relay 调用方必须引用已声明账户" });
      }
    }
  });
}
export const modelRelayConfigSchema = schema(false);

/** Old caller allowlists are accepted only by this explicit, opt-in upgrade. */
export function upgradeModelRelayModels(value) {
  const current = modelRelayConfigSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = schema(false, false, true).parse(value);
  for (const caller of legacy.callers) {
    if (!legacy.accounts.some(account => account.provider === caller.provider)) legacy.accounts.push({ provider: caller.provider });
  }
  for (const account of legacy.accounts) {
    account.models = [...new Set(legacy.callers.filter(caller => caller.provider === account.provider).flatMap(caller => caller.models))];
  }
  for (const caller of legacy.callers) delete caller.models;
  return modelRelayConfigSchema.parse(legacy);
}

/** Explicit upgrade only; runtime validation never accepts removed limit fields. */
export function upgradeModelRelayLimits(value) {
  const legacyModels = Array.isArray(value?.callers) && value.callers.some(caller => Object.hasOwn(caller, "models"));
  const legacy = schema(true, false, legacyModels).parse(value);
  for (const entry of [...legacy.accounts, ...legacy.callers]) {
    delete entry.max_concurrency; delete entry.requests_per_minute; delete entry.burst;
  }
  return upgradeModelRelayModels(legacy);
}

/** Projection of already validated configuration; never loads provider credentials. */
export function relayPolicyFromConfig(config) {
  const limit = value => ({ maxConcurrency: value.max_concurrency, requestsPerMinute: value.requests_per_minute, burst: value.burst });
  return { enabled: config.enabled, ...limit(config),
    retiredCallers: (config.retired_callers ?? []).map(({ caller_id, key_id, credential_generation }) =>
      ({ callerId: caller_id, keyId: key_id, credentialGeneration: credential_generation })),
    accounts: config.accounts.map(account => ({ provider: account.provider })),
    callers: config.callers.map(caller => ({ callerId: caller.caller_id, keyId: caller.key_id,
      credentialGeneration: caller.credential_generation, secretSha256: caller.secret_sha256,
      enabled: caller.enabled, provider: caller.provider, models: [...(config.accounts.find(account => account.provider === caller.provider)?.models ?? [])], reasoning: caller.reasoning ?? "passthrough" })) };
}

export function modelRelayConfigDigest(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** Only the explicit traffic upgrade accepts the removed capture fields. */
export function removeLegacyRelayCapture(value) {
  schema(false, true).parse(value);
  const current = { ...value };
  for (const key of ["traffic_dump", "traffic_dump_mode", "traffic_dump_debug"]) delete current[key];
  return current;
}
