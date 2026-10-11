import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { connectHomePath, providerStorageRoot } from "./connect-home.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";

import { compileModelDefinitions, validateModelDefinitions as validateResponsesModels } from "./model-catalog.mjs";
export { validateModelDefinitions as validateResponsesModels } from "./model-catalog.mjs";

const activeCatalogWrite = new AsyncLocalStorage();

const maximumBytes = 2 * 1024 * 1024;
export function isCustomCatalogProvider(id) {
  return typeof id === "string" && id.startsWith("cp-");
}

export function responsesProviderCatalogPath(environment, id) {
  if (!/^cp-[A-Za-z0-9_-]{1,61}$/u.test(id)) {
    throw new Error("自定义提供商 ID 必须为 cp- 加 1-61 位字母、数字、- 或 _");
  }
  return join(providerStorageRoot(environment), "responses", id, "models.json");
}

export function createResponsesModelCatalog(definitions, defaultModel, options) {
  const compiled = compileModelDefinitions(definitions, defaultModel, options);
  const catalog = { schemaVersion: 5, defaultModel, ...compiled };
  if (Buffer.byteLength(JSON.stringify(catalog, null, 2)) + 1 > maximumBytes) throw new Error("Responses 模型目录不能超过 2 MiB");
  return catalog;
}

/** Validate the on-disk contract independently of filesystem access. */
export function parseResponsesModelCatalog(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("Responses 模型目录不是有效 JSON"); }
  if (parsed?.schemaVersion !== 5 || Object.keys(parsed).some((key) => !["schemaVersion", "defaultModel", "definitions", "models"].includes(key))) throw new Error("Responses 模型目录版本或字段不受支持（仅支持版本 5）；请先保留配置与模型目录完整备份，再重新配置");
  const expected = createResponsesModelCatalog(parsed.definitions, parsed.defaultModel);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("Responses 模型目录与模型定义不一致，请重新生成");
  return expected;
}

export function readResponsesModelCatalog(environment, id) {
  assertResponsesContextSyncComplete(environment);
  const path = responsesProviderCatalogPath(environment, id);
  if (existsSync(`${path}.pending`) && activeCatalogWrite.getStore() !== path) throw new Error(`自定义提供商 ${id} 上次保存未完成；请先恢复目录事务`);
  let content;
  try { content = readPrivateFileSync(path, maximumBytes); } catch {
    throw new Error(`自定义提供商 ${id} 模型目录缺失或无法安全读取`);
  }
  const expected = parseResponsesModelCatalog(content);
  return { ...expected, path, content, revision: createHash("sha256").update(content).digest("hex") };
}

export function responsesModelSettings(environment, id, model) {
  const catalog = readResponsesModelCatalog(environment, id);
  const selected = catalog.definitions.find((entry) => entry.id === (model ?? catalog.defaultModel));
  if (!selected) throw new Error("模型 ID 不在该自定义提供商的目录中");
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
  if (existsSync(responsesContextSyncPath(environment))) throw new Error("DS/CP 上下文同步未完成，请停止服务并执行 primary-provider recover <Provider ID> keep 或 rollback");
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
