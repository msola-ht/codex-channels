import { existsSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory } from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountsFilePath,
  opencodeGoAccountMarkerPath,
  opencodeGoProviderId,
  validateOpencodeGoAccountId,
} from "../runtime/opencode-go-accounts.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { opencodeGoAccountPaths } from "./opencode-go-account-files.mjs";
import { hasLegacyOpencodeGoConfiguration, readLegacyOpencodeGoToml } from "./opencode-go-legacy-config.mjs";
import { applyProviderFileUpdates, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";

function legacyRemovalPlan(environment, accountId) {
  const home = codexHomePath(environment);
  const directory = managedProviderDirectory(environment, opencodeGoProviderDefinition);
  const accounts = loadOpencodeGoAccounts(environment);
  const account = accountId === undefined ? undefined : accounts.find((entry) => entry.id === accountId);
  if (accountId !== undefined) {
    validateOpencodeGoAccountId(accountId);
    if (!account) throw new Error("OpenCode Go 账户不存在");
    if (account.default && accounts.length > 1) throw new Error("请先选择其他 OpenCode Go 默认账户");
  }
  if (accountId === undefined && accounts.some((entry) =>
    readLegacyOpencodeGoToml(opencodeGoAccountMarkerPath(environment, entry.id)).provider === "opencode-go")) {
    throw new Error("旧单账户已登记账户 ID，请先使用 account remove <id> 移除该账户");
  }
  const markerPath = accountId === undefined ? join(directory, "managed.toml")
    : opencodeGoAccountMarkerPath(environment, accountId);
  const marker = readLegacyOpencodeGoToml(markerPath);
  const allowedProviders = accountId === undefined ? ["opencode-go"]
    : ["opencode-go", `opencode-go-${accountId}`, opencodeGoProviderId(accountId)];
  if (!hasLegacyOpencodeGoConfiguration(environment, accountId)
    || marker.version !== 1 || !allowedProviders.includes(marker.provider)
    || !["switching", "exclusive"].includes(marker.mode)) throw new Error("旧 OpenCode Go 管理标记无效");
  const configPath = join(home, "config.toml");
  const current = readLegacyOpencodeGoToml(configPath);
  const readPaths = [configPath, markerPath, opencodeGoAccountsFilePath(environment)];
  const profiles = accountId === undefined ? [join(home, "sf-opencode-go.config.toml")]
    : [join(home, `sf-opencode-go-${accountId}.config.toml`),
      ...(marker.provider === "opencode-go" || account.default ? [join(home, "sf-opencode-go.config.toml")] : [])];
  const existingProfiles = profiles.filter(existsSync);
  if (existingProfiles.length > 1) throw new Error("旧 OpenCode Go Profile 存在多个候选，请先核对");
  if (accountId !== undefined && existsSync(opencodeGoAccountPaths(environment, accountId).profilePath)) {
    throw new Error("OpenCode Go 新旧账户 Profile 同时存在，请先核对，未删除任何文件");
  }
  const profilePath = existingProfiles[0] ?? profiles[0];
  if (existsSync(profilePath) && readLegacyOpencodeGoToml(profilePath).model_provider !== marker.provider) {
    throw new Error("旧 OpenCode Go Profile 与管理标记不一致");
  }
  const remaining = accounts.filter((entry) => entry.id !== accountId);
  const updates = new Map([[markerPath, undefined], [profilePath, undefined]]);
  if (accountId !== undefined) updates.set(opencodeGoAccountsFilePath(environment),
    remaining.length === 0 ? undefined : `${JSON.stringify(remaining, null, 2)}\n`);
  if (remaining.length === 0 && (accountId === undefined || !existsSync(join(directory, "managed.toml")))) {
    updates.set(join(directory, "models.json"), undefined);
    updates.set(join(directory, "models.manifest.json"), undefined);
  }
  if (marker.mode === "exclusive") {
    if (current.model_provider !== marker.provider) throw new Error("旧 OpenCode Go 固定模式与主配置不一致");
    const backupDirectory = accountId === undefined ? join(directory, "backup")
      : opencodeGoAccountPaths(environment, accountId).backupDirectory;
    const baseline = join(backupDirectory, "config.toml");
    const sharedBaseline = join(directory, "backup", "config.toml");
    const statePath = join(directory, "backup", "state.json");
    readPaths.push(baseline, sharedBaseline, statePath);
    let initial;
    if (existsSync(baseline)) initial = readLegacyOpencodeGoToml(baseline);
    else if (existsSync(sharedBaseline)) initial = readLegacyOpencodeGoToml(sharedBaseline);
    else {
      let state;
      try { state = JSON.parse(readPrivateFileSync(statePath)); }
      catch { throw new Error("旧 OpenCode Go 初始配置备份缺失"); }
      if (state.config !== false) throw new Error("旧 OpenCode Go 初始配置备份缺失");
      initial = {};
    }
    updates.set(configPath, stringify(restoreProviderBaseConfig(current, initial,
      { ...opencodeGoProviderDefinition, id: marker.provider })));
  } else if (current.model_provider === marker.provider) {
    throw new Error("旧 OpenCode Go 切换模式与主配置不一致");
  }
  return { updates, snapshots: snapshotProviderFiles([...readPaths, ...updates.keys()]), provider: marker.provider,
    files: [...updates.keys()], mode: marker.mode, accountId };
}

export async function previewLegacyOpencodeGoRemoval(accountId, options = {}) {
  const plan = legacyRemovalPlan(options.environment ?? process.env, accountId);
  const runtime = await inspectManagedAccountRuntime(plan.provider, options);
  return { operation: "legacy-remove", account: { id: accountId, provider: plan.provider }, files: plan.files,
    effects: { stopsRunningAppServer: runtime.running, restoresInitialConfig: plan.mode === "exclusive",
      preservesPrivateBackup: true, historyThreadsBecomeUnavailable: true }, activation: "restart-all" };
}

export async function removeLegacyOpencodeGoAccount({ accountId, confirmRemove = false } = {}, options = {}) {
  if (confirmRemove !== true) throw new Error("移除旧 OpenCode Go 账户必须明确确认");
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = legacyRemovalPlan(environment, accountId);
    const runtime = await stopManagedAccountForRemoval(plan.provider, options);
    await applyProviderFileUpdates(plan.updates, plan.snapshots);
    return { action: "legacy-removed", runtime, activation: "restart-all" };
  });
}
