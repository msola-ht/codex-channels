import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { connectHomePath, providerStorageRoot } from "./connect-home.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";

const activeCatalogWrite = new AsyncLocalStorage();

const maximumBytes = 2 * 1024 * 1024;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const instructions = "You are a coding assistant. Follow the user's instructions, inspect the workspace before making changes, use the available tools when needed, and report results accurately. Respect tool permissions and do not claim actions succeeded without evidence.";

export function isResponsesProvider(id) {
  return typeof id === "string" && id.startsWith("rs-");
}

export function responsesProviderCatalogPath(environment, id) {
  if (!/^rs-[A-Za-z0-9_-]{1,61}$/u.test(id)) {
    throw new Error("自定义 Responses Provider ID 必须为 rs- 加 1-61 位字母、数字、- 或 _");
  }
  return join(providerStorageRoot(environment), "responses", id, "models.json");
}

export function validateResponsesModels(values, defaultModel) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
    throw new Error("自定义模型目录必须包含 1-64 个模型");
  }
  const seen = new Set();
  const models = values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["id", "name", "contextWindow", "reasoningEfforts", "defaultReasoningEffort", "supportsImages", "template"].includes(key))) {
      throw new Error("自定义模型包含不受支持的字段");
    }
    const { id, name, contextWindow, reasoningEfforts, defaultReasoningEffort, supportsImages } = value;
    if (typeof id !== "string" || id.trim() !== id || id.length < 1 || id.length > 200 || /\p{Cc}/u.test(id) || seen.has(id)) {
      throw new Error("自定义模型 ID 无效或重复");
    }
    if (typeof name !== "string" || name.trim() === "" || name.length > 120 || /\p{Cc}/u.test(name)) throw new Error("自定义模型显示名称无效");
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 100_000_000) throw new Error("模型上下文窗口必须为 1024-100000000 的整数");
    if (!Array.isArray(reasoningEfforts) || reasoningEfforts.some((effort) => !efforts.has(effort)) || new Set(reasoningEfforts).size !== reasoningEfforts.length) throw new Error("模型思考等级无效或重复");
    if (reasoningEfforts.length === 0 ? defaultReasoningEffort !== null : !reasoningEfforts.includes(defaultReasoningEffort)) throw new Error("默认思考等级必须属于模型声明的等级；不支持时必须为 null");
    if (typeof supportsImages !== "boolean") throw new Error("模型图片能力必须为布尔值");
    const template = value.template;
    if (template !== undefined && (!template || typeof template !== "object" || Array.isArray(template)
      || Object.keys(template).some(key => !["source", "model", "followContext", "snapshot"].includes(key)) || !["official", "deepseek"].includes(template.source)
      || typeof template.model !== "string" || template.model.trim() !== template.model || template.model.length < 1 || template.model.length > 200 || /\p{Cc}/u.test(template.model)
      || typeof template.followContext !== "boolean" || (template.source !== "deepseek" && template.followContext))) {
      throw new Error("模型模板关联无效；只有 DeepSeek 模板可跟随上下文");
    }
    if (template?.source !== undefined && template.source !== "official") {
      validateTemplateSnapshot(template.snapshot, template.model);
      if (template.snapshot.max_context_window != null && contextWindow > template.snapshot.max_context_window) throw new Error("模型上下文窗口不能超过模板最大上下文");
    } else if (template?.snapshot !== undefined) throw new Error("官方 Codex 模板不支持完整快照");
    seen.add(id);
    return { id, name: name.trim(), contextWindow, reasoningEfforts: [...reasoningEfforts], defaultReasoningEffort, supportsImages, ...(template === undefined ? {} : {template: {source: template.source, model: template.model, followContext: template.followContext, ...(template.snapshot === undefined ? {} : {snapshot: structuredClone(template.snapshot)})}}) };
  });
  if (!seen.has(defaultModel)) throw new Error("默认模型必须存在于自定义模型目录");
  return models;
}

export function createResponsesModelCatalog(definitions, defaultModel) {
  const validated = validateResponsesModels(definitions, defaultModel);
  const catalog = {
    schemaVersion: 3,
    defaultModel,
    definitions: validated,
    models: validated.map((model, index) => model.template?.snapshot ? materializeTemplate(model) : ({
      slug: model.id, display_name: model.name, description: "User-configured Responses model",
      default_reasoning_level: model.defaultReasoningEffort,
      supported_reasoning_levels: model.reasoningEfforts.map((effort) => ({ effort, description: effort })),
      shell_type: "unified_exec", visibility: "list", supported_in_api: true,
      priority: model.id === defaultModel ? 0 : index + 1,
      availability_nux: null, upgrade: null,
      model_messages: { instructions_template: instructions },
      include_apps_usage_instructions: false,
      supports_reasoning_summary_parameter: false,
      support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
      truncation_policy: { mode: "tokens", limit: Math.min(10_000, Math.floor(model.contextWindow / 4)) },
      context_window: model.contextWindow, max_context_window: model.contextWindow,
      effective_context_window_percent: 95, experimental_supported_tools: [],
      input_modalities: model.supportsImages ? ["text", "image"] : ["text"],
    })),
  };
  if (Buffer.byteLength(JSON.stringify(catalog, null, 2)) + 1 > maximumBytes) throw new Error("Responses 模型目录不能超过 2 MiB");
  return catalog;
}

export function readResponsesModelCatalog(environment, id) {
  assertResponsesContextSyncComplete(environment);
  const path = responsesProviderCatalogPath(environment, id);
  if (existsSync(`${path}.pending`) && activeCatalogWrite.getStore() !== path) throw new Error(`Responses Provider ${id} 上次保存未完成；请先恢复目录事务`);
  let content;
  try { content = readPrivateFileSync(path, maximumBytes); } catch {
    throw new Error(`Responses Provider ${id} 模型目录缺失或无法安全读取`);
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("Responses 模型目录不是有效 JSON"); }
  if (parsed?.schemaVersion !== 3 || Object.keys(parsed).some((key) => !["schemaVersion", "defaultModel", "definitions", "models"].includes(key))) throw new Error("Responses 模型目录版本或字段不受支持（仅支持版本 3）；请先保留配置与模型目录完整备份，再重新配置");
  const expected = createResponsesModelCatalog(parsed.definitions, parsed.defaultModel);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("Responses 模型目录与模型定义不一致，请重新生成");
  return { ...expected, path, content, revision: createHash("sha256").update(content).digest("hex") };
}

export function responsesModelSettings(environment, id, model) {
  const catalog = readResponsesModelCatalog(environment, id);
  const selected = catalog.definitions.find((entry) => entry.id === (model ?? catalog.defaultModel));
  if (!selected) throw new Error("模型 ID 不在该 Responses Provider 的目录中");
  return { catalog, model: selected.id, reasoningEffort: selected.defaultReasoningEffort };
}

export function writeResponsesModelCatalog(environment, id, definitions, model, expectedRevision) {
  assertResponsesContextSyncComplete(environment);
  const path = responsesProviderCatalogPath(environment, id);
  if (existsSync(`${path}.pending`)) throw new Error("Responses 模型目录上次保存未完成，请先恢复");
  const previous = existsSync(path) ? readResponsesModelCatalog(environment, id) : undefined;
  if (previous?.revision !== expectedRevision) throw new Error("Responses 模型目录已变化，请重新预览");
  const content = `${JSON.stringify(createResponsesModelCatalog(definitions, model), null, 2)}\n`;
  if (previous) writePrivateFileAtomicSync(`${path}.backup`, readPrivateFileSync(path, maximumBytes));
  writePrivateFileAtomicSync(`${path}.pending`, JSON.stringify({ schemaVersion: 1, previous: previous !== undefined }));
  writePrivateFileAtomicSync(path, content);
  return { path, previous };
}

export function finishResponsesModelCatalogWrite(transaction, rollback = false) {
  const { path, previous } = transaction;
  if (rollback) {
    if (previous) writePrivateFileAtomicSync(path, readPrivateFileSync(`${path}.backup`, maximumBytes));
    else if (existsSync(path)) unlinkSync(path);
  }
  try { unlinkSync(`${path}.pending`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export function removeResponsesModelCatalog(environment, id) {
  const path = responsesProviderCatalogPath(environment, id);
  for (const target of [path, `${path}.backup`, `${path}.pending`, responsesProviderBackupPath(environment, id)]) {
    try { unlinkSync(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function withResponsesModelCatalogWrite(transaction, operation) {
  return activeCatalogWrite.run(transaction.path, operation);
}

export function responsesProviderBackupPath(environment, id) {
  responsesProviderCatalogPath(environment, id);
  return join(connectHomePath(environment), "private", "responses-providers", `${id}.json`);
}

export function responsesContextSyncPath(environment) {
  return join(connectHomePath(environment), "private", "responses-context-sync.json");
}

export function assertResponsesContextSyncComplete(environment) {
  if (existsSync(responsesContextSyncPath(environment))) throw new Error("DS/RS 上下文同步未完成，请停止服务并执行 primary-provider recover <RS ID> keep 或 rollback");
}

export function resolveResponsesTemplateContexts(definitions, environment) {
  if (!definitions.some(model => model.template?.followContext)) return definitions;
  let source;
  try { source=JSON.parse(readPrivateFileSync(join(providerStorageRoot(environment),"deepseek","models.json"),maximumBytes)); } catch { throw new Error("跟随上下文需要可读取的本地 DS 模型目录，请先配置 DS 或关闭跟随"); }
  return definitions.map(model=>{
    if (!model.template?.followContext) return model;
    const matches=source.models?.filter(entry=>entry.slug === model.template.model);
    if (!Array.isArray(matches) || matches.length !== 1) throw new Error("跟随的 DS 模型不存在或不唯一，请重新选择模板或关闭跟随");
    const next={...model,contextWindow:matches[0].context_window};
    return validateResponsesModels([next],next.id)[0];
  });
}

// Current locked ModelInfo fields plus fields retained by the managed DS catalogs.
// Approval-policy metadata is deliberately unsupported: importing a template cannot change approvals.
const snapshotFields = new Set(`slug display_name description default_reasoning_level supported_reasoning_levels
shell_type visibility supported_in_api priority additional_speed_tiers service_tiers default_service_tier
available_access_programs availability_nux upgrade model_messages base_instructions
include_skills_usage_instructions include_plugin_usage_instructions include_apps_usage_instructions
supports_reasoning_summary_parameter default_reasoning_summary support_verbosity default_verbosity
apply_patch_tool_type web_search_tool_type truncation_policy supports_image_detail_original context_window
max_context_window auto_compact_token_limit comp_hash effective_context_window_percent experimental_supported_tools
input_modalities supports_search_tool supports_experimental_context use_responses_lite supports_reasoning_effort_updates
node_repl_auto_review_required node_repl_disabled auto_review_model_override model_specialty tool_mode
multi_agent_version multi_agent_reasoning_effort prefer_websockets supports_parallel_tool_calls
reasoning_summary_format minimal_client_version supports_reasoning_summaries`.split(/\s+/u));

function validateTemplateSnapshot(snapshot, slug) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || Object.keys(snapshot).some(key => !snapshotFields.has(key)) || snapshot.slug !== slug
    || typeof snapshot.display_name !== "string" || !Number.isSafeInteger(snapshot.context_window)
    || snapshot.context_window < 1024 || snapshot.context_window > 100_000_000
    || (snapshot.max_context_window != null && (!Number.isSafeInteger(snapshot.max_context_window) || snapshot.max_context_window < snapshot.context_window || snapshot.max_context_window > 100_000_000))
    || !Array.isArray(snapshot.supported_reasoning_levels) || snapshot.supported_reasoning_levels.some(entry => !entry || !efforts.has(entry.effort) || typeof entry.description !== "string")
    || !Array.isArray(snapshot.input_modalities) || !snapshot.input_modalities.includes("text")
    || snapshot.input_modalities.some(value => !["text", "image", "audio"].includes(value))
    || !["shell_command", "unified_exec", "default", "local", "disabled"].includes(snapshot.shell_type)
    || snapshot.visibility !== "list" || snapshot.supported_in_api !== true
    || !Number.isSafeInteger(snapshot.priority)
    || !snapshot.model_messages || typeof snapshot.model_messages.instructions_template !== "string"
    || snapshot.model_messages.guardian_v2 != null || snapshot.model_messages.confirmation_policies != null) {
    throw new Error("完整模型模板快照无效或包含不受支持的字段，请重新导入模板");
  }
  const visit = (value, depth = 0) => {
    if (depth > 20) throw new Error("模型模板快照嵌套过深");
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("模型模板快照必须为 JSON 数据");
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:__proto__|prototype|constructor|api[_-]?key|authorization|cookie|token|password|secret)$/iu.test(key)) throw new Error("模型模板快照包含不受支持的字段");
      visit(item, depth + 1);
    }
  };
  visit(snapshot);
}

function materializeTemplate(model) {
  const snapshot = structuredClone(model.template.snapshot);
  snapshot.slug = model.id;
  snapshot.display_name = model.name;
  snapshot.context_window = model.contextWindow;
  if ((snapshot.default_reasoning_level ?? null) !== model.defaultReasoningEffort) snapshot.default_reasoning_level = model.defaultReasoningEffort;
  snapshot.supported_reasoning_levels = model.reasoningEfforts.map(effort =>
    snapshot.supported_reasoning_levels.find(entry => entry.effort === effort) ?? {effort, description: effort});
  if (snapshot.input_modalities.includes("image") !== model.supportsImages) {
    snapshot.input_modalities = model.supportsImages ? [...snapshot.input_modalities, "image"] : snapshot.input_modalities.filter(value => value !== "image");
  }
  return snapshot;
}
