import { parseRelayModelId, relayModelId } from "../runtime/model-relay-model-id.mjs";
import { readClineRelayCatalog, downloadClineRelayCatalog, saveClineRelayCatalog } from "./cline-relay-catalog.mjs";
import { stringify } from "smol-toml";
import { createHash, randomBytes } from "node:crypto";
import { parseGatewayConfig, validateGatewayConfigDocument, withGatewayConfigLock } from "../runtime/gateway-config.mjs";
import { assertPrivateConfigAccessSync, readPrivateFileSync } from "../runtime/private-file.mjs";
import { modelRelayConfigDigest, modelRelayConfigSchema, relayKeyModelsSchema } from "../runtime/model-relay-config.mjs";
import { loadConfiguredRelayProviderMaterial, listRelayProviderIds } from "../runtime/model-provider-runtime.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { saveConfigWithBackup } from "./config-backup.mjs";
import { locateUserConfig } from "./runtime-config.mjs";

import { supportsChatReasoningOff } from "../runtime/chat-reasoning.mjs";
import { ConfigManagementError } from "./config-management-error.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

const commands = ["listen", "status", "providers", "callers", "issue", "edit", "delete", "rotate", "disable", "enable"];
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
  const clineCatalog = readClineRelayCatalog(environment);
  const materialRevisions = [];
  const providers = listRelayProviderIds(environment).map(id => {
    try {
      const material = loadConfiguredRelayProviderMaterial(id, environment);
      materialRevisions.push([id, material.revision]);
      return { id, available: true, protocols: material.protocols, models: material.models.map(idModel => {
        const inputs = Object.hasOwn(material.modelInputs, idModel) ? material.modelInputs[idModel] : undefined;
        const inputModalities = inputs?.length && inputs.every(value => ["text", "image", "audio", "video", "pdf"].includes(value)) ? [...new Set(inputs)] : [];
        return { id: idModel, relayId: relayModelId(id, idModel), reasoningOff: supportsChatReasoningOff(id, idModel) || (material.modelCapabilities ?? []).some(model => model.id === idModel && model.reasoning_efforts.includes("none")), inputModalities };
      }) };
    } catch { return { id, available: false, protocols: [], reason: "provider_material_unavailable", models: [] }; }
  });
  return { revision: createHash("sha256").update(content).update(JSON.stringify([providers, materialRevisions, clineCatalog])).digest("hex"),
    clineCatalog, enabled: config.enabled, maxConcurrency: config.max_concurrency, providers, callers: safeCallers(config.callers) };
}

/** Listener settings do not depend on Provider catalog availability. */
export function readRelayListener(environment = process.env) {
  const { configPath } = locateUserConfig(environment);
  assertPrivateConfigAccessSync(configPath);
  const content = readPrivateFileSync(configPath, 1024 * 1024);
  const config = validateGatewayConfigDocument(parseGatewayConfig(content)).model_relay ?? modelRelayConfigSchema.parse({});
  return { enabled: config.enabled, host: config.host, port: config.port,
    revision: createHash("sha256").update(content).digest("hex") };
}

function safeCallers(callers) {
  return callers.map(({ caller_id, key_id, credential_generation, enabled, reasoning, display_name, models }) =>
    ({ caller_id, key_id, credential_generation, enabled, models: [...models], ...(display_name === undefined ? {} : { display_name }), reasoning: reasoning ?? "passthrough" }));
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
  // Revision-bound confirmation must use exactly the catalog reviewed in its preview.
  if (!options.preview && options.expectedRevision === undefined && readClineRelayCatalog(environment).status === "missing"
    && (input.command === "providers" || ["issue", "edit"].includes(input.command) && input.models?.some(id => id.startsWith("clp-")))
    && listRelayProviderIds(environment).some(id => input.command === "providers" ? id.startsWith("clp-") : input.models?.some(model => model.startsWith(`${id}/`)))) {
    try {
      const catalog = await downloadClineRelayCatalog(environment);
      await withRelayManagementTransaction(environment, () => {
        // Downloads must not block revocation. Another owner may have saved a catalog meanwhile.
        if (readClineRelayCatalog(environment).status !== "missing") return {};
        return { activation: "catalog_saved", catalog: saveClineRelayCatalog(catalog, environment) };
      });
    } catch { throw invalid("Cline 模型目录自动下载失败，请检查网络后重试，或在 WebUI 手动下载"); }
  }
  if (["listen", "issue", "edit", "delete", "rotate", "disable", "enable"].includes(input.command)) {
    return withRelayManagementTransaction(environment, () => executeModelRelay(input, environment, options));
  }
  return executeModelRelay(input, environment, options);
}

async function executeModelRelay(input, environment, options) {
  if (!commands.includes(input.command)) throw invalid("未知 Relay 操作");
  if (Object.hasOwn(input, "extraModels") || ["issue", "edit"].includes(input.command) && Object.hasOwn(input, "provider")) throw invalid("提供商不再支持思考覆盖；请在 Key 设置思考策略");
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
  let secret;
  const result = withRelayConfigLock(configPath, () => {
    assertPrivateConfigAccessSync(configPath);
    if (options.expectedRevision !== undefined && readRelayManagement(environment).revision !== options.expectedRevision) throw conflict();
    const content = readPrivateFileSync(configPath, 1024 * 1024);
    if (options.expectedConfigRevision !== undefined && createHash("sha256").update(content).digest("hex") !== options.expectedConfigRevision) throw conflict();
    const document = parseGatewayConfig(content);
    const validated = validateGatewayConfigDocument(document);
    const config = structuredClone(validated.model_relay ?? modelRelayConfigSchema.parse({}));
    const previous = modelRelayConfigDigest(config);
    let removed;
    if (input.command === "listen") {
      if (typeof input.enabled !== "boolean" || typeof input.host !== "string") throw invalid("Relay 监听参数无效");
      config.host = input.host; config.enabled = input.enabled;
    } else if (input.command === "issue") {
      if ([...config.callers, ...(config.retired_callers ?? [])].some(caller => caller.caller_id === input.caller || caller.key_id === input.key)) throw invalid("Relay 身份已存在，包含停用或历史记录；不能重复使用");
      validateKeyModels(input.models, environment);
      const bytes = options.preview ? Buffer.alloc(32) : randomBytes(32); secret = `cr1.${input.key}.${bytes.toString("base64url")}`;
      config.callers.push({ caller_id: input.caller, key_id: input.key, credential_generation: 1,
        ...(input.name === undefined ? {} : { display_name: input.name }),
        secret_sha256: createHash("sha256").update(bytes).digest("hex"), enabled: true, models: [...input.models], ...(input.reasoning === "off" ? { reasoning: "off" } : {}) });
    } else if (input.command === "edit") {
      const caller = config.callers.find(value => value.caller_id === input.caller);
      if (!caller) throw invalid("Relay 调用方不存在");
      if (input.models !== undefined && JSON.stringify(input.models) !== JSON.stringify(caller.models)) {
        validateKeyModels(input.models, environment);
        retainSettlementIdentity(config, caller);
        caller.models = [...input.models];
      }
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
    const parsed = modelRelayConfigSchema.safeParse(config);
    if (!parsed.success) {
      const fields = new Set(parsed.error.issues.map(issue => issue.path.at(-1)));
      if (fields.has("reasoning")) throw invalid("模型思考策略须属于显式声明的支持等级");
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
    ...(activation === "saved_unconfirmed" ? { recovery: "生效未确认；需要立即停止入口时执行 codexc stop relay。不会撤销已保存的禁用。" } : {}) };
}

/** Retains settlement authority only; never a usable credential or request permission. */
function retainSettlementIdentity(config, caller) {
  const retired = config.retired_callers ??= [];
  for (const provider of new Set(caller.models.map(id => parseRelayModelId(id).provider))) {
    const existing = retired.find(value => value.caller_id === caller.caller_id && value.key_id === caller.key_id && value.provider === provider);
    if (existing) existing.credential_generation = Math.max(existing.credential_generation, caller.credential_generation);
    else {
      if (retired.length >= 4096) throw invalid("Relay 历史身份已达容量上限");
      retired.push({ caller_id: caller.caller_id, key_id: caller.key_id, provider, credential_generation: caller.credential_generation });
    }
  }
}

function validateKeyModels(models, environment) {
  const parsed = relayKeyModelsSchema.safeParse(models);
  if (!parsed.success) throw invalid("请为 Key 选择至少一个提供商/模型 ID，不能重复");
  const materials = new Map();
  for (const id of parsed.data) {
    const { provider } = parseRelayModelId(id);
    if (!materials.has(provider)) {
      try { materials.set(provider, loadConfiguredRelayProviderMaterial(provider, environment)); }
      catch { throw invalid("Key 提供商目录或凭据不可用，请刷新后重新选择模型"); }
    }
    if (materials.get(provider).models.filter(model => relayModelId(provider, model) === id).length !== 1) throw invalid("Key 模型在当前提供商目录中不可用");
  }
}
