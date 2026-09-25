import { existsSync } from "node:fs";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { validateBasicManagedProviderAccounts } from "./managed-provider-account-registry.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

export function validateClinePassAccountId(id) {
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(id)) {
    throw new Error("CLP 账户 ID 必须是 1–32 位小写字母、数字、- 或 _");
  }
  return id;
}

export function clinePassProviderId(id) {
  return `clp-${validateClinePassAccountId(id)}`;
}

export function isClinePassAccountProvider(provider) {
  return typeof provider === "string" && /^clp-[a-z0-9_-]{1,32}$/u.test(provider);
}

export function clinePassAccountIdFromProvider(provider) {
  return isClinePassAccountProvider(provider) ? provider.slice(4) : undefined;
}

export function clinePassAccountsFilePath(environment = process.env) {
  return join(providerStorageRoot(environment), "clp", "accounts.json");
}

export function clinePassAccountDirectory(environment, id) {
  return join(providerStorageRoot(environment), "clp", "accounts", validateClinePassAccountId(id));
}

export function clinePassAccountMarkerPath(environment, id) {
  return join(clinePassAccountDirectory(environment, id), "managed.toml");
}

export function clinePassApiKeyEnvironmentKey(id) {
  return `CODEX_CONNECT_CLP_${validateClinePassAccountId(id).replace(/-/gu, "_").toUpperCase()}_API_KEY`;
}

export function validateClinePassAccounts(value) {
  return validateBasicManagedProviderAccounts(value, {
    providerLabel: "CLP",
    validateAccountId: validateClinePassAccountId,
    credentialEnvironmentKey: clinePassApiKeyEnvironmentKey,
  });
}

export function loadClinePassAccounts(environment = process.env) {
  if (existsSync(join(providerStorageRoot(environment), "cline-pass", "managed.toml"))) {
    throw new Error("CLP 单账户配置不受支持，请先移除旧配置再重新设置账户");
  }
  const path = clinePassAccountsFilePath(environment);
  if (!existsSync(path)) return [];
  let value;
  try {
    value = JSON.parse(readPrivateFileSync(path, 262_144));
  } catch {
    throw new Error("CLP 账户注册表无法安全读取");
  }
  return validateClinePassAccounts(value);
}
