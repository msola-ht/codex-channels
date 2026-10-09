import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { providerStorageRoot } from "./connect-home.mjs";
import { isManagedProviderApiKeyValid } from "./model-provider-definitions.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

const maximumCredentialBytes = 16_384;

export function managedPrimaryCredentialEnvironmentKey(definition, version = randomUUID().replaceAll("-", "")) {
  if (!/^[a-f0-9]{32}$/u.test(version)) throw new Error("受管主 Provider 凭据版本无效");
  return `${definition.apiKeyEnvironmentKey}_PRIMARY_${version}`;
}

export function managedPrimaryCredentialPath(environment, definition, environmentKey) {
  const prefix = `${definition.apiKeyEnvironmentKey}_PRIMARY_`;
  const version = typeof environmentKey === "string" && environmentKey.startsWith(prefix)
    ? environmentKey.slice(prefix.length) : "";
  if (!/^[a-f0-9]{32}$/u.test(version)) throw new Error("受管主 Provider 凭据引用无效");
  return join(providerStorageRoot(environment), definition.storageId ?? definition.id,
    "primary-credentials", definition.id, `${version}.json`);
}

export function createManagedPrimaryCredential(definition, apiKey) {
  if (!isManagedProviderApiKeyValid(definition, apiKey)) throw new Error("受管主 Provider API Key 无效");
  const environmentKey = managedPrimaryCredentialEnvironmentKey(definition);
  const content = `${JSON.stringify({ schemaVersion: 1, providerId: definition.id,
    origin: new URL(definition.baseUrl).origin, apiKey })}\n`;
  if (Buffer.byteLength(content) > maximumCredentialBytes) throw new Error("受管主 Provider 凭据超过读取上限");
  return { environmentKey, content };
}

export function readManagedPrimaryCredential(environment, definition, environmentKey) {
  let credential;
  try {
    credential = JSON.parse(readPrivateFileSync(managedPrimaryCredentialPath(environment, definition, environmentKey), maximumCredentialBytes));
  } catch {
    throw new Error("受管主 Provider 私有凭据无法安全读取；请显式重新配置账户");
  }
  if (credential === null || typeof credential !== "object" || Array.isArray(credential)
    || Object.keys(credential).length !== 4 || credential.schemaVersion !== 1
    || credential.providerId !== definition.id || credential.origin !== new URL(definition.baseUrl).origin
    || !isManagedProviderApiKeyValid(definition, credential.apiKey)) {
    throw new Error("受管主 Provider 私有凭据格式或 Provider/Origin 绑定无效");
  }
  return credential.apiKey;
}
