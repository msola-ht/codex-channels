import { stringify } from "smol-toml";
import { createHash, randomBytes } from "node:crypto";
import { parseGatewayConfig, validateGatewayConfigDocument, withGatewayConfigLock } from "../runtime/gateway-config.mjs";
import { assertPrivateConfigAccessSync, readPrivateFileSync } from "../runtime/private-file.mjs";
import { modelRelayConfigDigest, modelRelayConfigSchema, upgradeModelRelayLimits } from "../runtime/model-relay-config.mjs";
import { loadConfiguredRelayProviderMaterial, listRelayProviderIds } from "../runtime/model-provider-runtime.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { saveConfigWithBackup } from "./config-backup.mjs";
import { locateUserConfig } from "./runtime-config.mjs";

import { supportsChatReasoningOff } from "../runtime/chat-reasoning.mjs";
import { ConfigManagementError } from "./config-management-error.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";

const commands = ["status", "providers", "callers", "issue", "edit", "delete", "rotate", "disable", "enable", "upgrade-limits", "rollback-reasoning", "rollback-names", "rollback-providers", "rollback-retired"];
const invalid = message => new ConfigManagementError("relay_invalid", "relay", message);
const conflict = () => new ConfigManagementError("stale-revision", "relay", "Relay 配置或模型目录已变化，请刷新后重新预览");

/** Read-only runtime snapshot, independent of provider catalogs and edit revisions. */
export async function readRelayQueue(environment = process.env) {
  const { configPath } = locateUserConfig(environment);
  const result = await queryModelRelayControl(modelRelayPaths(configPath).control, "queue");
  return result.result === "queue" ? { state: "running", configurationValid: result.configurationValid, enabled: result.enabled,
    listening: result.listening, requests: result.requests }
    : { state: result.result === "not_running" ? "stopped" : "unknown" };
}

export function readRelayManagement(environment = process.env) {
  const { configPath } = locateUserConfig(environment);
  assertPrivateConfigAccessSync(configPath);
  const content = readPrivateFileSync(configPath, 1024 * 1024);
  const document = validateGatewayConfigDocument(parseGatewayConfig(content));
  const config = document.model_relay ?? modelRelayConfigSchema.parse({});
  const materialRevisions = [];
  const providers = listRelayProviderIds(environment).map(id => {
    try {
      const material = loadConfiguredRelayProviderMaterial(id, environment);
      materialRevisions.push([id, material.revision]);
      return { id, available: true, protocols: material.protocols, models: material.models.map(idModel => {
        const inputs = material.modelInputs[idModel];
        const inputModalities = inputs?.length && inputs.every(value => ["text", "image", "audio"].includes(value)) ? [...new Set(inputs)] : [];
        return { id: idModel, reasoningOff: supportsChatReasoningOff(id, idModel), inputModalities };
      }) };
    } catch { return { id, available: false, protocols: [], reason: "provider_material_unavailable", models: [] }; }
  });
  return { revision: createHash("sha256").update(content).update(JSON.stringify([providers, materialRevisions])).digest("hex"),
    enabled: config.enabled, maxConcurrency: config.max_concurrency, providers, callers: safeCallers(config.callers) };
}

function safeCallers(callers) {
  return callers.map(({ caller_id, key_id, credential_generation, enabled, provider, models, reasoning, display_name }) =>
    ({ caller_id, key_id, credential_generation, enabled, provider, models, ...(display_name === undefined ? {} : { display_name }), reasoning: reasoning ?? "passthrough" }));
}

// Only recover a completed mutation result: failures before callback completion still fail closed.
export async function withRelayManagementTransaction(environment, operation) {
  let completed;
  try {
    return await withModelProviderManagementTransaction(environment, async () => {
      const result = await operation();
      if (result.activation) completed = result;
      return result;
    });
  } catch (error) {
    if (completed) return { ...completed, cleanupStatus: "failed" };
    throw error;
  }
}

function withRelayConfigLock(configPath, operation) {
  let completed;
  try {
    return withGatewayConfigLock(configPath, () => {
      const result = operation();
      if (!result.preview) completed = result;
      return result;
    });
  } catch (error) {
    if (completed) return { ...completed, cleanupStatus: "failed" };
    throw error;
  }
}

/** Explicit configuration transaction; service activation occurs only after atomic save. */
export async function manageModelRelay(input, environment = process.env, options = {}) {
  if (["issue", "edit", "delete", "rotate", "disable", "enable"].includes(input.command)) {
    return withRelayManagementTransaction(environment, () => executeModelRelay(input, environment, options));
  }
  return executeModelRelay(input, environment, options);
}

async function executeModelRelay(input, environment, options) {
  if (!commands.includes(input.command)) throw invalid("未知 Relay 操作");
  if (input.reasoning !== undefined && !["passthrough", "off"].includes(input.reasoning)) throw invalid("思考策略无效");
  const { configPath } = locateUserConfig(environment);
  const endpoint = modelRelayPaths(configPath).control;
  if (input.command === "status") return { ...await queryModelRelayControl(endpoint, "status"),
    metricsNotice: "指标计数仅覆盖当前进程；accepted 仅表示接收队列确认，unconfirmed 可能已落盘，崩溃后的计数与样本不完整。" };
  assertPrivateConfigAccessSync(configPath);
  if (input.command === "providers") return { providers: readRelayManagement(environment).providers };
  if (input.command === "callers") {
    const document = validateGatewayConfigDocument(parseGatewayConfig(readPrivateFileSync(configPath, 1024 * 1024)));
    return { callers: safeCallers(document.model_relay?.callers ?? []) };
  }
  if (input.command === "upgrade-limits") return withRelayConfigLock(configPath, () => {
    assertPrivateConfigAccessSync(configPath);
    const content = readPrivateFileSync(configPath, 1024 * 1024);
    const document = parseGatewayConfig(content);
    if (document.model_relay === undefined) {
      validateGatewayConfigDocument(document); return { result: "unchanged", backupPath: null };
    }
    const upgraded = upgradeModelRelayLimits(document.model_relay);
    const entries = [...(document.model_relay.accounts ?? []), ...(document.model_relay.callers ?? [])];
    const changed = entries.some(entry => ["max_concurrency", "requests_per_minute", "burst"].some(key => Object.hasOwn(entry, key)));
    if (!changed) { validateGatewayConfigDocument(document); return { result: "unchanged", backupPath: null }; }
    document.model_relay = upgraded;
    validateGatewayConfigDocument(document);
    return { result: "upgraded", backupPath: saveConfigWithBackup(configPath, content, document, "relay", { maximumBytes: 1024 * 1024 }) };
  });
  if (["rollback-reasoning", "rollback-names", "rollback-providers", "rollback-retired"].includes(input.command)) {
    if (await gatewayOwnerIsActive(configPath) || (await queryModelRelayControl(endpoint, "status")).result !== "not_running") {
      throw invalid("回退前须停止 Gateway、Relay 和 WebUI（含前台实例）；将按命令移除对应名称、策略、提供商引用或历史身份摘要");
    }
  }
  let secret;
  const result = withRelayConfigLock(configPath, () => {
    assertPrivateConfigAccessSync(configPath);
    if (options.expectedRevision !== undefined && readRelayManagement(environment).revision !== options.expectedRevision) throw conflict();
    const content = readPrivateFileSync(configPath, 1024 * 1024);
    const document = parseGatewayConfig(content);
    const validated = validateGatewayConfigDocument(document);
    if (["rollback-reasoning", "rollback-names", "rollback-providers", "rollback-retired"].includes(input.command) && validated.model_relay === undefined) return { result: "unchanged", backupPath: null };
    const config = structuredClone(validated.model_relay ?? modelRelayConfigSchema.parse({}));
    const previous = modelRelayConfigDigest(config);
    let removed;
    if (input.command === "issue") {
      if ([...config.callers, ...(config.retired_callers ?? [])].some(caller => caller.caller_id === input.caller || caller.key_id === input.key)) throw invalid("Relay 身份已存在，包含停用或历史记录；不能重复使用");
      const material = loadConfiguredRelayProviderMaterial(input.provider, environment);
      if (input.models.some(model => !material.models.includes(model))) throw invalid("Relay 模型不在账户目录中");
      if (!config.accounts.some(account => account.provider === input.provider)) config.accounts.push({ provider: input.provider });
      const bytes = options.preview ? Buffer.alloc(32) : randomBytes(32); secret = `cr1.${input.key}.${bytes.toString("base64url")}`;
      config.callers.push({ caller_id: input.caller, key_id: input.key, credential_generation: 1,
        ...(input.name === undefined ? {} : { display_name: input.name }),
        secret_sha256: createHash("sha256").update(bytes).digest("hex"), enabled: true, provider: input.provider, models: input.models, ...(input.reasoning === "off" ? { reasoning: "off" } : {}) });
    } else if (input.command === "rollback-retired") {
      delete config.retired_callers;
    } else if (input.command === "rollback-providers") {
      const selected = new Set(input.providers);
      const nonClp = value => !/^clp-[a-z0-9_-]{1,32}$/u.test(value.provider);
      if (!selected.size || [...selected].some(id => ![...config.accounts, ...config.callers].some(value => value.provider === id && nonClp(value)))
        || [...config.accounts, ...config.callers].some(value => nonClp(value) && !selected.has(value.provider))) {
        throw invalid("必须明确列出全部非 CLP Relay 账户；不允许删除 CLP 账户或隐式移除其他引用");
      }
      config.accounts = config.accounts.filter(value => !selected.has(value.provider));
      config.callers = config.callers.filter(value => !selected.has(value.provider));
    } else if (["rollback-reasoning", "rollback-names"].includes(input.command)) {
      for (const caller of config.callers) {
        if (input.command === "rollback-names") delete caller.display_name;
        else delete caller.reasoning;
      }
    } else if (input.command === "edit") {
      const caller = config.callers.find(value => value.caller_id === input.caller);
      if (!caller) throw invalid("Relay 调用方不存在");
      const provider = input.provider ?? caller.provider;
      if (provider !== caller.provider && !input.models?.length) throw invalid("更换提供商时必须明确选择模型");
      const models = input.models?.length ? input.models : caller.models;
      const policyChanged = provider !== caller.provider || models.length !== caller.models.length || models.some(model => !caller.models.includes(model))
        || input.reasoning !== undefined && input.reasoning !== (caller.reasoning ?? "passthrough");
      if (policyChanged) {
        const material = loadConfiguredRelayProviderMaterial(provider, environment);
        if (models.some(model => !material.models.includes(model))) throw invalid("Relay 模型不在账户目录中");
      }
      if (caller.provider !== provider) {
        if (!config.accounts.some(account => account.provider === provider)) config.accounts.push({ provider });
        retainSettlementIdentity(config, caller);
      }
      caller.provider = provider;
      caller.models = models;
      if (input.name !== undefined) caller.display_name = input.name;
      if (input.reasoning === "off") caller.reasoning = "off";
      else if (input.reasoning === "passthrough") delete caller.reasoning;
    } else if (input.command === "delete") {
      removed = config.callers.find(value => value.caller_id === input.caller);
      if (!removed) throw invalid("Relay 调用方不存在");
      retainSettlementIdentity(config, removed);
      config.callers = config.callers.filter(value => value !== removed);
    } else if (input.command === "rotate" || input.command === "disable" && input.caller) {
      const caller = config.callers.find(value => value.caller_id === input.caller);
      if (!caller) throw invalid("Relay 调用方不存在");
      if (input.command === "disable") caller.enabled = false;
      else {
        if (caller.credential_generation >= Number.MAX_SAFE_INTEGER) throw new Error("Relay 凭据代次已耗尽");
        const bytes = options.preview ? Buffer.alloc(32) : randomBytes(32); secret = `cr1.${caller.key_id}.${bytes.toString("base64url")}`;
        caller.secret_sha256 = createHash("sha256").update(bytes).digest("hex"); caller.credential_generation++; caller.enabled = true;
      }
    } else config.enabled = input.command === "enable";
    if (["issue", "edit", "delete"].includes(input.command)) {
      const referenced = new Set(config.callers.map(caller => caller.provider));
      config.accounts = config.accounts.filter(account => referenced.has(account.provider));
    }
    const parsed = modelRelayConfigSchema.safeParse(config);
    if (!parsed.success) {
      const fields = new Set(parsed.error.issues.map(issue => issue.path.at(-1)));
      if (fields.has("reasoning")) throw invalid("所选提供商和模型不支持强制关闭思考；请查询 codexc relay providers 或选择跟随请求");
      if (fields.has("display_name")) throw invalid("用途名称须为 1–64 个字符，不含控制字符或首尾空白");
      throw invalid("Relay 身份、模型或配置限制无效；请核对身份格式、模型列表及账户/Key 数量限制");
    }
    document.model_relay = parsed.data;
    validateGatewayConfigDocument(document);
    if (Buffer.byteLength(stringify(document), "utf8") > 1024 * 1024) throw invalid("Relay 配置达到文件容量上限，未修改配置");
    const digest = modelRelayConfigDigest(modelRelayConfigSchema.parse(document.model_relay ?? {}));
    if (options.preview) return { preview: { command: input.command, caller: input.caller,
      callers: safeCallers(removed ? [removed] : config.callers).filter(caller => caller.caller_id === input.caller) } };
    let backupPath = null;
    if (previous !== digest || validated.model_relay === undefined) {
      backupPath = saveConfigWithBackup(configPath, content, document, "relay", { maximumBytes: 1024 * 1024 });
    }
    return { digest, backupPath };
  });
  if (options.preview || result.result === "unchanged") return result;
  let response;
  try { response = await queryModelRelayControl(endpoint, "apply", result.digest); }
  catch { response = { result: "unconfirmed" }; }
  const activation = response.result === "applied" ? "saved_and_applied" : response.result === "not_running" ? "saved_not_running" : "saved_unconfirmed";
  return { activation, backupPath: result.backupPath, ...(result.cleanupStatus ? { cleanupStatus: result.cleanupStatus } : {}), ...(secret === undefined ? {} : { key: secret }),
    ...(activation === "saved_unconfirmed" ? { recovery: "生效未确认；需要立即停止入口时执行 codexc service stop relay。不会撤销已保存的禁用。" } : {}) };
}

/** Retains settlement authority only; never a usable credential or request permission. */
function retainSettlementIdentity(config, caller) {
  const retired = config.retired_callers ??= [];
  const existing = retired.find(value => value.caller_id === caller.caller_id && value.key_id === caller.key_id && value.provider === caller.provider);
  if (existing) existing.credential_generation = Math.max(existing.credential_generation, caller.credential_generation);
  else {
    if (retired.length >= 4096) throw invalid("Relay 历史身份摘要已达容量上限，未修改配置");
    const { caller_id, key_id, provider, credential_generation } = caller;
    retired.push({ caller_id, key_id, provider, credential_generation });
  }
}
