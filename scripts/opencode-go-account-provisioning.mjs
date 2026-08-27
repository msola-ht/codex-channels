import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import {
  opencodeGoAccountDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
} from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountsFilePath,
  opencodeGoDefaultAccountId,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccountMarker,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomic,
} from "../runtime/private-file.mjs";
import { configureThirdPartyRole } from "./agents.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import {
  applyExclusiveProviderConfig,
  createManagedProviderCatalog,
  createSwitchingProviderProfile,
  hasProviderBaseConfig,
  restoreProviderBaseConfig,
} from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import {
  assertOpencodeGoFileSnapshots,
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
  readOptionalOpencodeGoFile,
  refreshOpencodeGoFileSnapshot,
  replaceOptionalOpencodeGoFile,
  restoreOpencodeGoFileSnapshots,
  snapshotOpencodeGoFiles,
} from "./opencode-go-account-files.mjs";

const definition = opencodeGoProviderDefinition;
const defaultAutoCompactPercent = 60;
const defaultAccountId = opencodeGoDefaultAccountId;
const maximumPrivateConfigBytes = 2_097_152;
const previousDefaultModel = "deepseek-v4-flash";

export class OpenCodeGoAccountProvisioningError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "OpenCodeGoAccountProvisioningError";
    this.code = code;
    this.field = field;
  }
}

export async function previewOpencodeGoAccountConfiguration(
  { accountId, mode = "switching", reconfigure = false },
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadPrimaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  return publicPreview(await buildPlan({ accountId, mode, reconfigure }, {
    environment,
    loadAccounts,
    loadPrimaryProvider,
  }));
}

export async function applyOpencodeGoAccountConfiguration(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(
    environment,
    () => applyOpencodeGoAccountConfigurationUnlocked(input, options),
  );
}

async function applyOpencodeGoAccountConfigurationUnlocked(
  {
    accountId,
    mode = "switching",
    reconfigure = false,
    apiKey,
    confirmExclusiveConfigChange = false,
  },
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    downloadCatalog = downloadDeepseekCatalog,
    loadAccounts = loadOpencodeGoAccounts,
    loadPrimaryProvider = loadPrimaryModelProvider,
    configureRole = configureThirdPartyRole,
  } = {},
) {
  const plan = await buildPlan({ accountId, mode, reconfigure }, {
    environment,
    loadAccounts,
    loadPrimaryProvider,
  });
  if (mode === "exclusive" && confirmExclusiveConfigChange !== true) {
    throw invalid(
      "confirmation-required",
      "confirmExclusiveConfigChange",
      "固定模式会修改并备份 Codex 主配置，必须先明确确认",
    );
  }
  if (typeof apiKey !== "string" || !/^sk-[^\s"]+$/u.test(apiKey) || apiKey.length > 4_096) {
    throw invalid("invalid-api-key", "apiKey", "OpenCode Go API Key 无效");
  }

  let catalogState;
  try {
    catalogState = await loadCatalog(plan, { fetchImpl, downloadCatalog });
  } catch (error) {
    throw normalize("catalog-unavailable", "catalog", error);
  }
  let previous;
  try {
    previous = loadManagedModelProviderSettings(environment).find(
      (candidate) => candidate.provider === plan.account.provider,
    );
  } catch (error) {
    throw normalize("provider-state-unavailable", "accountId", error);
  }
  const selectedModel = previous?.model ?? definition.defaultModel;
  let managedCatalog;
  try {
    managedCatalog = createManagedProviderCatalog(
      catalogState.catalog,
      definition,
      {
        previousModels: previous?.models,
        autoCompactPercent: defaultAutoCompactPercent,
      },
    );
  } catch (error) {
    throw normalize("catalog-invalid", "catalog", error);
  }
  const transactionPaths = [
    plan.paths.configPath,
    plan.paths.profilePath,
    plan.paths.markerPath,
    plan.paths.roleConfigPath,
    plan.paths.catalogPath,
    plan.paths.manifestPath,
    opencodeGoAccountsFilePath(environment),
  ];
  let snapshots;
  try {
    snapshots = snapshotOpencodeGoFiles(transactionPaths);
  } catch (error) {
    throw normalize("operation-failed", "action", error);
  }
  let guards = snapshots;
  try {
    await assertOpencodeGoFileSnapshots(guards);
    mkdirSync(plan.paths.accountDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(plan.paths.backupDirectory, { recursive: true, mode: 0o700 });
    if (plan.accounts.length === 0) await preserveInitialFiles(plan.paths);
    const currentConfig = await readTomlFile(plan.paths.configPath);
    const initialConfig = await readBackupToml(plan.paths);
    let nextConfig = currentConfig;
    let profileContent;
    if (mode === "switching") {
      if (readOpencodeGoAccountMarker(environment, accountId)?.mode === "exclusive") {
        nextConfig = restoreProviderBaseConfig(
          currentConfig,
          initialConfig,
          opencodeGoAccountDefinition(accountId),
        );
      }
      if (hasProviderBaseConfig(nextConfig, opencodeGoAccountDefinition(accountId))) {
        throw new Error(
          `安装前的 Codex config.toml 已占用 ${plan.account.provider} Provider 或 Profile；请先手工移除或改名`,
        );
      }
      const selectedModelEntry = managedCatalog.models?.find(
        (entry) => entry?.slug === selectedModel,
      );
      const reasoningEffort = selectedModelEntry?.default_reasoning_level;
      if (typeof reasoningEffort !== "string") {
        throw new Error("OpenCode Go 模型目录缺少默认思考等级");
      }
      profileContent = stringify(createSwitchingProviderProfile(
        opencodeGoAccountDefinition(accountId),
        {
          apiKey,
          catalogPath: plan.paths.catalogPath,
          model: selectedModel,
          reasoningEffort,
        },
      ));
    } else {
      nextConfig = applyExclusiveProviderConfig(
        currentConfig,
        opencodeGoAccountDefinition(accountId),
        { apiKey, catalogPath: plan.paths.catalogPath, model: selectedModel },
      );
    }
    const catalogContent = `${JSON.stringify(managedCatalog, null, 2)}\n`;
    await assertOpencodeGoFileSnapshots(guards);
    await writePrivateFileAtomic(plan.paths.catalogPath, catalogContent);
    guards = refreshOpencodeGoFileSnapshot(guards, plan.paths.catalogPath);
    await assertOpencodeGoFileSnapshots(guards);
    await replaceOptionalOpencodeGoFile(
      plan.paths.manifestPath,
      catalogState.manifest === undefined
        ? undefined
        : `${JSON.stringify(catalogState.manifest, null, 2)}\n`,
    );
    guards = refreshOpencodeGoFileSnapshot(guards, plan.paths.manifestPath);
    await assertOpencodeGoFileSnapshots(guards);
    await replaceOptionalOpencodeGoFile(
      plan.paths.configPath,
      Object.keys(nextConfig).length === 0 ? undefined : stringify(nextConfig),
    );
    guards = refreshOpencodeGoFileSnapshot(guards, plan.paths.configPath);
    await assertOpencodeGoFileSnapshots(guards);
    await replaceOptionalOpencodeGoFile(plan.paths.profilePath, profileContent);
    guards = refreshOpencodeGoFileSnapshot(guards, plan.paths.profilePath);
    await assertOpencodeGoFileSnapshots(guards);
    writeOpencodeGoAccountMarker(environment, accountId, mode);
    guards = refreshOpencodeGoFileSnapshot(guards, plan.paths.markerPath);
    await assertOpencodeGoFileSnapshots(guards);
    writeOpencodeGoAccounts(environment, plan.nextAccounts);
    guards = refreshOpencodeGoFileSnapshot(
      guards,
      opencodeGoAccountsFilePath(environment),
    );
    if (plan.updatesExternalAgent) {
      await assertOpencodeGoFileSnapshots(guards);
      await configureRole(plan.account.provider, selectedModel, environment);
    }
  } catch (error) {
    try {
      await restoreOpencodeGoFileSnapshots(snapshots, guards);
    } catch (rollbackError) {
      throw normalize("rollback-failed", "action", new AggregateError(
        [error, rollbackError],
        "OpenCode Go 账户配置失败，且未能完整恢复操作前文件",
        { cause: rollbackError },
      ));
    }
    throw normalize("operation-failed", "action", error);
  }
  return {
    action: "configured",
    ...publicPreview(plan),
    model: selectedModel,
    paths: publicPaths(plan.paths),
  };
}

async function buildPlan(
  { accountId, mode, reconfigure },
  { environment, loadAccounts, loadPrimaryProvider },
) {
  try {
    validateOpencodeGoAccountId(accountId);
  } catch (error) {
    throw normalize("invalid-account-id", "accountId", error);
  }
  if (mode !== "switching" && mode !== "exclusive") {
    throw invalid("invalid-mode", "mode", "OpenCode Go 账户管理模式无效");
  }
  let accounts;
  try {
    accounts = loadAccounts(environment);
  } catch (error) {
    throw normalize("account-state-unavailable", "accountId", error);
  }
  const existing = accounts.find((account) => account.id === accountId);
  if (existing !== undefined && reconfigure !== true) {
    throw invalid("account-exists", "accountId", `OpenCode Go 账户已存在：${accountId}`);
  }
  if (mode === "exclusive") {
    let primary;
    try {
      primary = loadPrimaryProvider(environment);
    } catch (error) {
      throw normalize("provider-state-unavailable", "mode", error);
    }
    if (primary !== "openai" && primary !== opencodeGoProviderId(accountId)) {
      throw invalid("primary-provider-conflict", "mode", `请先恢复当前固定 Provider：${primary}`);
    }
    if (accounts.length > 1) {
      throw invalid(
        "exclusive-account-conflict",
        "mode",
        "固定模式只允许一个 OpenCode Go 账户，其余账户必须使用切换模式",
      );
    }
  }
  const paths = opencodeGoAccountPaths(environment, accountId);
  try {
    await assertProfileOwnership(paths, accountId, environment);
  } catch (error) {
    throw normalize("profile-conflict", "accountId", error);
  }
  const updatesExternalAgent = accounts.length === 0 || existing?.default === true;
  return {
    account: {
      id: accountId,
      provider: opencodeGoProviderId(accountId),
      exists: existing !== undefined,
      default: accounts.length === 0 || existing?.default === true,
    },
    accounts,
    nextAccounts: existing === undefined
      ? [...accounts, { id: accountId, default: accounts.length === 0 }]
      : accounts.map((account) => account.id === accountId
          ? { id: accountId, default: account.default }
          : account),
    mode,
    reconfigure,
    paths,
    downloadsCatalog: existing !== undefined || !existsSync(paths.catalogPath),
    updatesExternalAgent,
  };
}

async function loadCatalog(plan, { fetchImpl, downloadCatalog }) {
  if (!plan.downloadsCatalog) {
    return {
      catalog: JSON.parse(readPrivateFileSync(
        plan.paths.catalogPath,
        maximumPrivateConfigBytes,
      )),
      manifest: existsSync(plan.paths.manifestPath)
        ? JSON.parse(readPrivateFileSync(plan.paths.manifestPath, maximumPrivateConfigBytes))
        : undefined,
    };
  }
  const downloaded = await downloadCatalog(fetchImpl);
  const previousManifest = await readOpencodeGoOptionalJson(
    plan.paths.manifestPath,
    "OpenCode Go 模型目录清单",
  );
  const migration = readOpencodeGoDefaultModelMigration(previousManifest);
  return {
    catalog: downloaded.catalog,
    manifest: {
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: new Date().toISOString(),
      ...(migration === undefined ? {} : { defaultModelMigration: migration }),
    },
  };
}

function publicPreview(plan) {
  return {
    operation: plan.account.exists ? "reconfigure" : "add",
    account: plan.account,
    mode: plan.mode,
    effects: {
      writesMainConfig: plan.mode === "exclusive",
      writesIsolatedProfile: plan.mode === "switching",
      downloadsCatalog: plan.downloadsCatalog,
      updatesExternalAgent: plan.updatesExternalAgent,
    },
    confirmation: {
      required: plan.mode === "exclusive",
      field: "confirmExclusiveConfigChange",
    },
    activation: "restart-all",
  };
}

function publicPaths(paths) {
  return {
    configPath: paths.configPath,
    profilePath: paths.profilePath,
    markerPath: paths.markerPath,
    catalogPath: paths.catalogPath,
  };
}

async function readBackupToml(paths) {
  const statePath = join(
    paths.providerDirectory,
    definition.backupDirectoryName,
    "state.json",
  );
  if (!existsSync(statePath)) return {};
  const state = JSON.parse(readPrivateFileSync(statePath));
  return state.config
    ? readTomlFile(join(paths.providerDirectory, definition.backupDirectoryName, "config.toml"))
    : {};
}

async function preserveInitialFiles(paths) {
  const backup = join(paths.providerDirectory, definition.backupDirectoryName);
  const statePath = join(backup, "state.json");
  if (existsSync(statePath)) return;
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const state = {
    config: await backupOptional(paths.configPath, join(backup, "config.toml")),
    profile: await backupOptional(
      paths.profilePath,
      join(backup, opencodeGoProfileFileName(defaultAccountId)),
    ),
    marker: await backupOptional(paths.markerPath, join(backup, "managed.toml")),
    roleConfig: await backupOptional(
      paths.roleConfigPath,
      join(backup, "sf-agent.config.toml"),
    ),
    catalog: await backupOptional(
      paths.catalogPath,
      join(backup, definition.catalogFileName),
    ),
    manifest: await backupOptional(
      paths.manifestPath,
      join(backup, definition.catalogManifestFileName),
    ),
  };
  await writePrivateFileAtomic(statePath, `${JSON.stringify(state)}\n`);
}

async function backupOptional(source, target) {
  const content = await readOptionalOpencodeGoFile(source);
  if (content === undefined) return false;
  await writePrivateFileAtomic(target, content);
  return true;
}

async function readTomlFile(path) {
  const content = await readOptionalOpencodeGoFile(path);
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全读取或解析");
  }
}

async function assertProfileOwnership(paths, accountId, environment) {
  const profile = await readOptionalOpencodeGoFile(paths.profilePath);
  const marker = readOpencodeGoAccountMarker(environment, accountId);
  if (profile === undefined && marker === undefined) return;
  if (marker === undefined) {
    throw new Error(
      `OpenCode Go 账户管理标记不存在，拒绝覆盖现有 Profile：${paths.profilePath}`,
    );
  }
}

export async function readOpencodeGoOptionalJson(path, label) {
  const content = await readOptionalOpencodeGoFile(path);
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label}无法安全读取或解析`);
  }
}

export function readOpencodeGoDefaultModelMigration(manifest) {
  const migration = manifest?.defaultModelMigration;
  if (migration === undefined) return undefined;
  if (!migration
    || typeof migration !== "object"
    || Array.isArray(migration)
    || migration.from !== previousDefaultModel
    || migration.to !== definition.defaultModel
    || typeof migration.appliedAt !== "string"
    || !Number.isFinite(Date.parse(migration.appliedAt))) {
    throw new Error("OpenCode Go 默认模型迁移标记无效");
  }
  return migration;
}

function normalize(code, field, error) {
  if (error instanceof OpenCodeGoAccountProvisioningError) return error;
  return invalid(
    code,
    field,
    error instanceof Error ? error.message : String(error),
    error,
  );
}

function invalid(code, field, message, cause) {
  return new OpenCodeGoAccountProvisioningError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}
