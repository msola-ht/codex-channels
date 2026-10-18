// Explicit recovery of an interrupted historical transaction only. No new cross-provider writes.
import { loadClinePassAccounts, clinePassProviderId, isClinePassAccountProvider } from "./cline-pass-accounts.mjs";
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadManagedModelProviderDefinitions } from "./model-provider-definitions.mjs";
import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { responsesProviderCatalogPath, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";

const maximumBytes = 16 * 1024 * 1024;

function assertCurrent(file) {
  const current = readPrivateFileSync(file.path, maximumBytes);
  if (current !== file.previous && current !== file.next) throw new Error("旧上下文恢复文件已变化，拒绝覆盖；请核对私有恢复记录");
}

export function recoverResponsesContextSync(environment, id, action) {
  if (!["keep", "rollback"].includes(action)) throw new Error("恢复操作无效");
  const path = responsesContextSyncPath(environment);
  if (!existsSync(path)) return false;
  let journal;
  try { journal = JSON.parse(readPrivateFileSync(path, maximumBytes)); } catch { throw new Error("旧上下文恢复记录无法安全读取"); }
  if (journal?.schemaVersion !== 1 || Object.keys(journal).length !== 2 || !Array.isArray(journal.files) || journal.files.length < 2) throw new Error("旧上下文恢复记录格式无效");
  const clineAccount = isClinePassAccountProvider(id);
  if (clineAccount && !loadClinePassAccounts(environment).some(account => clinePassProviderId(account.id) === id)) throw new Error("CLP 账户未注册，拒绝恢复");
  const target = clineAccount ? join(providerStorageRoot(environment), "clp", "models.json") : responsesProviderCatalogPath(environment, id);
  const seen = new Set();
  for (const file of journal.files) {
    if (!file || Object.keys(file).length !== 3 || typeof file.path !== "string" || typeof file.previous !== "string" || typeof file.next !== "string"
      || seen.has(file.path) || !allowedPath(file.path, environment)) throw new Error("旧上下文恢复文件无效");
    seen.add(file.path);
  }
  if (!seen.has(target)) throw new Error("该 Provider 不在待恢复的上下文事务中");
  for (const file of journal.files) assertCurrent(file);
  for (const file of journal.files) {
    assertCurrent(file);
    writePrivateFileAtomicSync(file.path, action === "keep" ? file.next : file.previous);
  }
  for (const file of journal.files) {
    if (readPrivateFileSync(file.path, maximumBytes) !== (action === "keep" ? file.next : file.previous)) throw new Error("旧上下文恢复后文件已变化，保留恢复记录");
  }
  unlinkSync(path);
  return true;
}

function allowedPath(path, environment) {
  if (path === join(providerStorageRoot(environment), "deepseek", "models.json")) return true;
  for (const definition of loadManagedModelProviderDefinitions(environment)) {
    if (path === join(providerStorageRoot(environment), definition.storageId ?? definition.id, definition.catalogFileName)
      || path === join(codexHomePath(environment), definition.profileFileName)) return true;
  }
  if (path === join(codexHomePath(environment), "sf-deepseek.config.toml")) return true;
  if (dirname(path) === codexHomePath(environment) && /^sf-ds-[a-z0-9_-]{1,32}\.config\.toml$/u.test(basename(path))) return true;
  const id = basename(dirname(path));
  return /^cp-[A-Za-z0-9_-]{1,61}$/u.test(id) && path === responsesProviderCatalogPath(environment, id);
}
