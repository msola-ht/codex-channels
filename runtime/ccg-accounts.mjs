import { existsSync } from "node:fs";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

export function validateCcgAccountId(id) {
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(id)) {
    throw new Error("CCG 账户 ID 必须是 1–32 位小写字母、数字、- 或 _");
  }
  return id;
}

export function ccgProviderId(id) {
  return `ccg-${validateCcgAccountId(id)}`;
}

export function isCcgAccountProvider(provider) {
  return typeof provider === "string" && /^ccg-[a-z0-9_-]{1,32}$/u.test(provider);
}

export function ccgAccountIdFromProvider(provider) {
  return isCcgAccountProvider(provider) ? provider.slice(4) : undefined;
}

export function ccgAccountsFilePath(environment = process.env) {
  return join(providerStorageRoot(environment), "ccg", "accounts.json");
}

export function ccgAccountDirectory(environment, id) {
  return join(providerStorageRoot(environment), "ccg", "accounts", validateCcgAccountId(id));
}

export function ccgAccountMarkerPath(environment, id) {
  return join(ccgAccountDirectory(environment, id), "managed.toml");
}

export function ccgApiKeyEnvironmentKey(id) {
  return `CODEX_CONNECT_CCG_${validateCcgAccountId(id).replace(/-/gu, "_").toUpperCase()}_API_KEY`;
}

export function validateCcgAccounts(value) {
  if (!Array.isArray(value)) throw new Error("CCG 账户注册表无效");
  const ids = new Set();
  const keys = new Set();
  let defaults = 0;
  const accounts = value.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)
      || Object.keys(account).some((key) => !["id", "default"].includes(key))
      || typeof account.default !== "boolean") throw new Error("CCG 账户记录无效");
    const id = validateCcgAccountId(account.id);
    const key = ccgApiKeyEnvironmentKey(id);
    if (ids.has(id) || keys.has(key)) throw new Error("CCG 账户 ID 或凭据变量名重复");
    ids.add(id);
    keys.add(key);
    if (account.default) defaults += 1;
    return { id, default: account.default };
  });
  if (accounts.length > 0 && defaults !== 1) throw new Error("CCG 必须有一个默认账户");
  return accounts;
}

export function loadCcgAccounts(environment = process.env) {
  const path = ccgAccountsFilePath(environment);
  if (!existsSync(path)) return [];
  let value;
  try {
    value = JSON.parse(readPrivateFileSync(path, 262_144));
  } catch {
    throw new Error("CCG 账户注册表无法安全读取");
  }
  return validateCcgAccounts(value);
}

export function loadCcgDefaultAccount(environment = process.env) {
  return loadCcgAccounts(environment).find((account) => account.default);
}
