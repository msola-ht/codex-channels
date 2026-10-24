import { createHmac, randomBytes } from "node:crypto";
import { parse } from "smol-toml";
import { customSwitchingProviderRegistryPath, loadCustomSwitchingProviderIds, loadPrimaryModelProvider, loadConfiguredProviderCredential } from "../runtime/model-provider-runtime.mjs";
import { isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { managedPrimaryCredentialPath } from "../runtime/managed-provider-credentials.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { join } from "node:path";
import { AccountManagementError } from "./account-management-error.mjs";
import { snapshotProviderFiles } from "./managed-provider-files.mjs";

// A private process key prevents exposed revisions from becoming credential guesses.
const revisionKey = randomBytes(32);

// Only the public fields belong in a preview; apiKey stays inside the management boundary.
export function managedAccountConfigurationEdit(input, previous, definition, environment) {
  if (input.reconfigure !== undefined && typeof input.reconfigure !== "boolean") {
    throw new AccountManagementError("invalid-input", "reconfigure", "reconfigure 必须为布尔值");
  }
  const mode = input.mode === undefined ? previous?.mode ?? "switching" : input.mode;
  if (mode !== "switching" && mode !== "exclusive") throw new AccountManagementError("invalid-mode", "mode", "账户运行模式无效");
  if (previous && !previous.models.some(model => model.model === previous.model)) {
    throw new AccountManagementError("account-default-model-missing", "model", "账户默认模型不在当前目录中，请先在模型管理中设置有效的账户默认模型");
  }
  let currentApiKey;
  if (previous) {
    try { currentApiKey = loadConfiguredProviderCredential(definition.id, environment).apiKey; }
    catch {
      if (input.apiKey === undefined) throw new AccountManagementError("invalid-api-key", "apiKey", "现有 API Key 无法安全读取，请显式填写新 Key");
    }
  }
  const apiKey = input.apiKey === undefined ? currentApiKey : input.apiKey;
  if (!isManagedProviderApiKeyValid(definition, apiKey)) throw new AccountManagementError("invalid-api-key", "apiKey", "请输入有效 API Key；新增账户必须填写 Key");
  const willChange = previous === undefined || mode !== previous.mode || apiKey !== currentApiKey;
  return { apiKey, mode, previousMode: previous?.mode, credentialAction: apiKey === currentApiKey ? "preserve" : "replace", willChange };
}

export function assertManagedAccountMode(mode, definition, environment, loadPrimary = loadPrimaryModelProvider) {
  if (mode !== "exclusive") return;
  if (!["openai", definition.id].includes(loadPrimary(environment))) {
    throw new AccountManagementError("primary-provider-conflict", "mode", "请先恢复当前固定 Provider");
  }
  if (loadCustomSwitchingProviderIds(environment).length > 0) {
    throw new AccountManagementError("primary-provider-conflict", "mode", "请先移除自定义切换 Provider，再设置受管固定账户");
  }
}

export function snapshotManagedAccountFiles(paths, definition, environment) {
  const snapshots = snapshotProviderFiles([...paths, customSwitchingProviderRegistryPath(environment)], environment);
  const config = snapshots.find(item => item.path === join(codexHomePath(environment), "config.toml"));
  if (config?.content !== undefined) {
    let document;
    try { document = parse(config.content.toString("utf8")); }
    catch { throw new AccountManagementError("provider-state-unavailable", "accountId", "Codex 主配置无法安全解析"); }
    const environmentKey = document.model_providers?.[definition.id]?.env_key;
    if (typeof environmentKey === "string" && environmentKey.startsWith(`${definition.apiKeyEnvironmentKey}_PRIMARY_`)) {
      snapshots.push(...snapshotProviderFiles([managedPrimaryCredentialPath(environment, definition, environmentKey)], environment));
    }
  }
  return snapshots;
}

export function managedAccountRevision(snapshots) {
  const digest = createHmac("sha256", revisionKey);
  for (const snapshot of [...snapshots].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(JSON.stringify([snapshot.path, snapshot.content === undefined ? null : snapshot.content.toString("base64")]));
  }
  return digest.digest("hex");
}

export function assertManagedAccountRevision(expected, actual) {
  if (expected !== undefined && expected !== actual) {
    throw new AccountManagementError("stale-preview", "accountId", "账户配置或凭据已变化，请重新预览并确认");
  }
}
