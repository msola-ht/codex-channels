import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadManagedModelProviderDefinitions } from "./model-provider-definitions.mjs";
import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { createResponsesModelCatalog, isResponsesProvider, readResponsesModelCatalog, responsesProviderCatalogPath, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";

const maximumBytes = 16 * 1024 * 1024;

// Extend the existing DS catalog/Profile transaction with mapped RS catalogs.
export function writeResponsesContextFollowers(updates, environment, originals = new Map(), targetModel) {
  const sourcePath = join(providerStorageRoot(environment), "deepseek", "models.json");
  if (!updates.has(sourcePath)) return false;
  if (!originals.has(sourcePath)) originals.set(sourcePath,readPrivateFileSync(sourcePath,maximumBytes));
  const source = JSON.parse(updates.get(sourcePath));
  const previousSource=JSON.parse(originals.get(sourcePath));
  const windows = new Map(source.models.filter(model=>targetModel === undefined
    ? previousSource.models.find(old=>old.slug === model.slug)?.context_window !== model.context_window
    : model.slug === targetModel).map(model => [model.slug, model.context_window]));
  const directory = join(providerStorageRoot(environment), "responses");
  if (!existsSync(directory)) return false;
  const next = new Map(updates);
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    if (!isResponsesProvider(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("RS 模型目录类型无效");
    const catalogPath=responsesProviderCatalogPath(environment,entry.name);
    if (!existsSync(catalogPath) && !existsSync(`${catalogPath}.pending`)) continue;
    const catalog = readResponsesModelCatalog(environment, entry.name);
    let matched = false;
    const definitions = catalog.definitions.map(model => {
      if (model.template?.source !== "deepseek" || !model.template.followContext || !windows.has(model.template.model) || model.contextWindow === windows.get(model.template.model)) return model;
      matched = true;
      return {...model, contextWindow: windows.get(model.template.model)};
    });
    if (matched) {
      next.set(catalog.path, `${JSON.stringify(createResponsesModelCatalog(definitions,catalog.defaultModel))}\n`);
      originals.set(catalog.path,catalog.content);
    }
  }
  if (next.size === updates.size) return false;
  const path = responsesContextSyncPath(environment);
  if (existsSync(path)) throw new Error("DS/RS 上下文同步尚未恢复");
  const files = [...next].map(([path,content]) => ({path,previous:originals.get(path) ?? readPrivateFileSync(path,maximumBytes),next:content}));
  for (const file of files) assertCurrent(file,false);
  const journal = {schemaVersion:1,files};
  const content = JSON.stringify(journal);
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("DS/RS 上下文同步备份超过大小限制");
  writePrivateFileAtomicSync(`${path}.backup`,content);
  writePrivateFileAtomicSync(path,content);
  try {
    for (const file of files) {
      assertCurrent(file, false);
      writePrivateFileAtomicSync(file.path,file.next);
    }
    for (const file of files) if (readPrivateFileSync(file.path,maximumBytes) !== file.next) throw new Error("DS/RS 上下文写入后文件已变化");
    unlinkSync(path);
  } catch (error) {
    try {
      restoreFiles(files,"rollback");
      unlinkSync(path);
    } catch (rollbackError) {
      throw new AggregateError([error,rollbackError],"DS/RS 上下文同步结果无法确认，已保留恢复记录；请停止服务后执行 primary-provider recover <RS ID> keep 或 rollback",{cause:rollbackError});
    }
    throw error;
  }
  return true;
}

function assertCurrent(file, allowNext = true) {
  const current = readPrivateFileSync(file.path,maximumBytes);
  if (current !== file.previous && (!allowNext || current !== file.next)) throw new Error("DS/RS 上下文同步文件已变化，拒绝覆盖；请核对私有恢复记录");
}

function restoreFiles(files,action) {
  for (const file of files) assertCurrent(file);
  for (const file of files) {
    assertCurrent(file);
    writePrivateFileAtomicSync(file.path,action === "keep" ? file.next : file.previous);
  }
  for (const file of files) {
    if (readPrivateFileSync(file.path,maximumBytes) !== (action === "keep" ? file.next : file.previous)) throw new Error("DS/RS 上下文恢复后文件已变化，保留恢复记录");
  }
}

export function recoverResponsesContextSync(environment,id,action) {
  if (!["keep","rollback"].includes(action)) throw new Error("恢复操作无效");
  const path = responsesContextSyncPath(environment);
  if (!existsSync(path)) return false;
  let journal;
  try { journal=JSON.parse(readPrivateFileSync(path,maximumBytes)); } catch { throw new Error("DS/RS 上下文恢复记录无法安全读取"); }
  if (journal?.schemaVersion !== 1 || Object.keys(journal).length !== 2 || !Array.isArray(journal.files) || journal.files.length < 2) throw new Error("DS/RS 上下文恢复记录格式无效");
  const target = responsesProviderCatalogPath(environment,id);
  const seen=new Set();
  for (const file of journal.files) {
    if (!file || Object.keys(file).length !== 3 || typeof file.path !== "string" || typeof file.previous !== "string" || typeof file.next !== "string" || seen.has(file.path) || !allowedPath(file.path,environment)) throw new Error("DS/RS 上下文恢复文件无效");
    seen.add(file.path);
  }
  if (!seen.has(target)) throw new Error("该 RS Provider 不在待恢复的上下文事务中");
  restoreFiles(journal.files,action);
  unlinkSync(path);
  return true;
}

function allowedPath(path,environment) {
  for (const definition of loadManagedModelProviderDefinitions(environment)) {
    if (path === join(providerStorageRoot(environment), definition.storageId ?? definition.id, definition.catalogFileName)
      || path === join(codexHomePath(environment), definition.profileFileName)) return true;
  }
  if (path === join(codexHomePath(environment),"sf-deepseek.config.toml")) return true;
  if (dirname(path) === codexHomePath(environment) && /^sf-ds-[a-z0-9_-]{1,32}\.config\.toml$/u.test(basename(path))) return true;
  const id=basename(dirname(path));
  return /^rs-[A-Za-z0-9_-]{1,61}$/u.test(id) && path === responsesProviderCatalogPath(environment,id);
}

export function listResponsesContextFollowers(environment, model) {
  const directory=join(providerStorageRoot(environment),"responses");
  if (!existsSync(directory)) return [];
  return readdirSync(directory,{withFileTypes:true}).filter(entry=>isResponsesProvider(entry.name)).flatMap(entry=>{
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("RS 模型目录类型无效");
    const path=responsesProviderCatalogPath(environment,entry.name);
    if (!existsSync(path) && !existsSync(`${path}.pending`)) return [];
    return readResponsesModelCatalog(environment,entry.name).definitions.filter(value=>value.template?.source === "deepseek" && value.template.followContext && (model === undefined || value.template.model === model)).map(value=>({providerId:entry.name,model:value.id,contextWindow:value.contextWindow}));
  });
}
