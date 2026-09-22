import { existsSync } from "node:fs";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { validateBasicManagedProviderAccounts } from "./managed-provider-account-registry.mjs";
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
  return validateBasicManagedProviderAccounts(value, {
    providerLabel: "DeepSeek",
    validateAccountId: validateDeepseekAccountId,
    credentialEnvironmentKey: deepseekApiKeyEnvironmentKey,
  });
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
