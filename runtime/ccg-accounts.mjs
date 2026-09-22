import { existsSync } from "node:fs";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { validateBasicManagedProviderAccounts } from "./managed-provider-account-registry.mjs";
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
  return validateBasicManagedProviderAccounts(value, {
    providerLabel: "CCG",
    validateAccountId: validateCcgAccountId,
    credentialEnvironmentKey: ccgApiKeyEnvironmentKey,
  });
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
