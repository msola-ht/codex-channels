import { lstatSync } from "node:fs";
import { join } from "node:path";

import { providerStorageRoot } from "./connect-home.mjs";
import { validateBasicManagedProviderAccounts } from "./managed-provider-account-registry.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

export function validateOllamaCloudAccountId(id) {
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(id)) {
    throw new Error("Ollama Cloud 账户 ID 必须是 1–32 位小写字母、数字、- 或 _");
  }
  return id;
}

export function ollamaCloudProviderId(id) {
  return `olc-${validateOllamaCloudAccountId(id)}`;
}

export function isOllamaCloudAccountProvider(provider) {
  return typeof provider === "string" && /^olc-[a-z0-9_-]{1,32}$/u.test(provider);
}

export function ollamaCloudAccountIdFromProvider(provider) {
  return isOllamaCloudAccountProvider(provider) ? provider.slice(4) : undefined;
}

export function ollamaCloudAccountsFilePath(environment = process.env) {
  return join(providerStorageRoot(environment), "ollama-cloud", "accounts.json");
}

export function ollamaCloudAccountDirectory(environment, id) {
  return join(providerStorageRoot(environment), "ollama-cloud", ollamaCloudProviderId(id));
}

export function ollamaCloudAccountMarkerPath(environment, id) {
  return join(ollamaCloudAccountDirectory(environment, id), "managed.toml");
}

export function ollamaCloudApiKeyEnvironmentKey(id) {
  return `CODEX_CONNECT_OLLAMA_CLOUD_${validateOllamaCloudAccountId(id).replace(/-/gu, "_").toUpperCase()}_API_KEY`;
}

export function validateOllamaCloudAccounts(value) {
  return validateBasicManagedProviderAccounts(value, {
    providerLabel: "Ollama Cloud",
    validateAccountId: validateOllamaCloudAccountId,
    credentialEnvironmentKey: ollamaCloudApiKeyEnvironmentKey,
  });
}

export function loadOllamaCloudAccounts(environment = process.env) {
  const path = ollamaCloudAccountsFilePath(environment);
  try {
    // Missing files are unconfigured; dangling links and access failures are not.
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    // 文件系统异常可能包含私有路径，不向调用方暴露原文。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Ollama Cloud 账户注册表无法安全读取");
  }
  let value;
  try {
    value = JSON.parse(readPrivateFileSync(path, 262_144));
  } catch {
    throw new Error("Ollama Cloud 账户注册表无法安全读取");
  }
  return validateOllamaCloudAccounts(value);
}
