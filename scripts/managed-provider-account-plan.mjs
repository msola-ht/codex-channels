import { createHmac, randomBytes } from "node:crypto";
import { parse } from "smol-toml";
import { customSwitchingProviderRegistryPath, loadCustomSwitchingProviderIds, loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { managedPrimaryCredentialPath } from "../runtime/managed-provider-credentials.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { join } from "node:path";
import { AccountManagementError } from "./account-management-error.mjs";
import { snapshotProviderFiles } from "./managed-provider-files.mjs";

// A private process key prevents exposed revisions from becoming credential guesses.
const revisionKey = randomBytes(32);

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
