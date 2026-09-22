import { existsSync } from "node:fs";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

export function validateDeepseekAccountId(id) {
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(id)) {
    throw new Error("DeepSeek 账户 ID 必须是 1–32 位小写字母、数字、- 或 _");
  }
  return id;
}

export function deepseekProviderId(id) {
  return `ds-${validateDeepseekAccountId(id)}`;
}

export function isDeepseekAccountProvider(provider) {
  return typeof provider === "string" && /^ds-[a-z0-9_-]{1,32}$/u.test(provider);
}

export function deepseekAccountIdFromProvider(provider) {
  return isDeepseekAccountProvider(provider) ? provider.slice(3) : undefined;
}

export function deepseekAccountsFilePath(environment = process.env) {
  return join(providerStorageRoot(environment), "deepseek", "accounts.json");
}

export function deepseekAccountDirectory(environment, id) {
  return join(providerStorageRoot(environment), "deepseek", "accounts", validateDeepseekAccountId(id));
}

export function deepseekAccountMarkerPath(environment, id) {
  return join(deepseekAccountDirectory(environment, id), "managed.toml");
}

export function deepseekApiKeyEnvironmentKey(id) {
  return `CODEX_CONNECT_DEEPSEEK_${validateDeepseekAccountId(id).replace(/-/gu, "_").toUpperCase()}_API_KEY`;
}

export function validateDeepseekAccounts(value) {
  if (!Array.isArray(value)) throw new Error("DeepSeek 账户注册表无效");
  const ids = new Set();
  const keys = new Set();
  let defaults = 0;
  const accounts = value.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)
      || Object.keys(account).some((key) => !["id", "default"].includes(key))
      || typeof account.default !== "boolean") throw new Error("DeepSeek 账户记录无效");
    const id = validateDeepseekAccountId(account.id);
    const key = deepseekApiKeyEnvironmentKey(id);
    if (ids.has(id) || keys.has(key)) throw new Error("DeepSeek 账户 ID 或凭据变量名重复");
    ids.add(id);
    keys.add(key);
    if (account.default) defaults += 1;
    return { id, default: account.default };
  });
  if (accounts.length > 0 && defaults !== 1) throw new Error("DeepSeek 必须有一个默认账户");
  return accounts;
}

export function loadDeepseekAccounts(environment = process.env) {
  const path = deepseekAccountsFilePath(environment);
  if (!existsSync(path)) return [];
  let value;
  try {
    value = JSON.parse(readPrivateFileSync(path, 262_144));
  } catch {
    throw new Error("DeepSeek 账户注册表无法安全读取");
  }
  return validateDeepseekAccounts(value);
}
