import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import {
  opencodeGoAccountDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelWindow,
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
} from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountsFilePath,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  validateOpencodeGoAccountId,
  validateOpencodeGoContact,
  validateOpencodeGoEmail,
  validateOpencodeGoPhone,
  opencodeGoAccountDisplayName,
  writeOpencodeGoAccountMarker,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomic,
} from "../runtime/private-file.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { createOpencodeGoCatalog } from "./provider-model-catalog.mjs";
import {
  createManagedProviderConfiguration,
  createManagedProviderCatalog,
  resolveManagedCatalogModel,
} from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import {
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
} from "./opencode-go-account-files.mjs";
import {
  assertProviderFileSnapshots,
  readOptionalProviderFile,
  refreshProviderFileSnapshot,
  replaceOptionalProviderFile,
  restoreProviderFileSnapshots,
  snapshotProviderFiles,
} from "./managed-provider-files.mjs";

const definition = opencodeGoProviderDefinition;
const maximumPrivateConfigBytes = 2_097_152;

export class OpenCodeGoAccountProvisioningError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "OpenCodeGoAccountProvisioningError";
    this.code = code;
    this.field = field;
  }
}

export async function previewOpencodeGoAccountConfiguration(
  { accountId, email, phone, contact, mode = "switching", reconfigure = false },
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadPrimaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  return publicPreview(await buildPlan({ accountId, email, phone, contact, mode, reconfigure }, {
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
    email,
    phone,
    contact,
    apiKey,
    confirmExclusiveConfigChange = false,
  },
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    downloadCatalog = downloadDeepseekCatalog,
    loadAccounts = loadOpencodeGoAccounts,
    loadPrimaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  const plan = await buildPlan({ accountId, email, phone, contact, mode, reconfigure }, {
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
  let windowPercentByModel;
  try {
    windowPercentByModel = configuredWindowPercentByModel(environment);
  } catch (error) {
    throw normalize("provider-state-unavailable", "accountId", error);
  }
  let managedCatalog;
  try {
    managedCatalog = createManagedProviderCatalog(
      catalogState.catalog,
      definition,
      {
        previousModels: previous?.models,
        modelWindowPercentByModel: windowPercentByModel,
      },
    );
  } catch (error) {
    throw normalize("catalog-invalid", "catalog", error);
  }
  const selectedModel = resolveManagedCatalogModel(
    managedCatalog,
    definition,
    previous?.model,
  );
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
    snapshots = snapshotProviderFiles(transactionPaths);
  } catch (error) {
    throw normalize("operation-failed", "action", error);
  }
  let guards = snapshots;
  try {
    await assertProviderFileSnapshots(guards);
    mkdirSync(plan.paths.accountDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(plan.paths.backupDirectory, { recursive: true, mode: 0o700 });
    if (plan.accounts.length === 0) {
      await preserveInitialFiles(plan.paths, plan.account.id);
    }
    const currentConfig = await readTomlFile(plan.paths.configPath);
    const initialConfig = await readBackupToml(plan.paths);
    const { config: nextConfig, profile } = createManagedProviderConfiguration(
      currentConfig,
      initialConfig,
      opencodeGoAccountDefinition(accountId, plan.account.email, plan.account.phone),
      {
        mode,
        previousMode: readOpencodeGoAccountMarker(environment, accountId)?.mode,
        apiKey, catalogPath: plan.paths.catalogPath, catalog: managedCatalog, model: selectedModel,
      },
    );
    const profileContent = profile === undefined ? undefined : stringify(profile);
    const catalogContent = `${JSON.stringify(managedCatalog, null, 2)}\n`;
    await assertProviderFileSnapshots(guards);
    await writePrivateFileAtomic(plan.paths.catalogPath, catalogContent);
    guards = refreshProviderFileSnapshot(guards, plan.paths.catalogPath);
    await assertProviderFileSnapshots(guards);
    await replaceOptionalProviderFile(
      plan.paths.manifestPath,
      catalogState.manifest === undefined
        ? undefined
        : `${JSON.stringify(catalogState.manifest, null, 2)}\n`,
    );
    guards = refreshProviderFileSnapshot(guards, plan.paths.manifestPath);
    await assertProviderFileSnapshots(guards);
    await replaceOptionalProviderFile(
      plan.paths.configPath,
      Object.keys(nextConfig).length === 0 ? undefined : stringify(nextConfig),
    );
    guards = refreshProviderFileSnapshot(guards, plan.paths.configPath);
    await assertProviderFileSnapshots(guards);
    await replaceOptionalProviderFile(plan.paths.profilePath, profileContent);
    guards = refreshProviderFileSnapshot(guards, plan.paths.profilePath);
    await assertProviderFileSnapshots(guards);
    writeOpencodeGoAccountMarker(environment, accountId, mode);
    guards = refreshProviderFileSnapshot(guards, plan.paths.markerPath);
    await assertProviderFileSnapshots(guards);
    writeOpencodeGoAccounts(environment, plan.nextAccounts);
    guards = refreshProviderFileSnapshot(
      guards,
      opencodeGoAccountsFilePath(environment),
    );
  } catch (error) {
    try {
      await restoreProviderFileSnapshots(snapshots, guards);
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
  { accountId, email, phone, contact, mode, reconfigure },
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
  if ([contact, email, phone].filter((value) => value !== undefined).length > 1) {
    throw invalid(
      "invalid-contact",
      "contact",
      "OpenCode Go 账户的邮箱和手机号只能二选一",
    );
  }
  let normalizedEmail = existing?.email;
  let normalizedPhone = existing?.phone;
  if (contact !== undefined || email !== undefined || phone !== undefined) {
    try {
      if (contact !== undefined) {
        const normalizedContact = validateOpencodeGoContact(contact);
        normalizedEmail = normalizedContact.type === "email" ? normalizedContact.value : undefined;
        normalizedPhone = normalizedContact.type === "phone" ? normalizedContact.value : undefined;
      } else if (email !== undefined) {
        normalizedEmail = validateOpencodeGoEmail(email);
        normalizedPhone = undefined;
      } else {
        normalizedPhone = validateOpencodeGoPhone(phone);
        normalizedEmail = undefined;
      }
    } catch (error) {
      throw normalize("invalid-contact", "contact", error);
    }
  }
  if (normalizedEmail === undefined && normalizedPhone === undefined) {
    throw invalid("invalid-contact", "contact", "OpenCode Go 账户必须提供邮箱或手机号码");
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
  return {
    account: {
      id: accountId,
      provider: opencodeGoProviderId(accountId),
      ...(normalizedEmail === undefined ? {} : { email: normalizedEmail }),
      ...(normalizedPhone === undefined ? {} : { phone: normalizedPhone }),
      displayName: opencodeGoAccountDisplayName({
        id: accountId,
        email: normalizedEmail,
        phone: normalizedPhone,
      }),
      exists: existing !== undefined,
      default: accounts.length === 0 || existing?.default === true,
    },
    accounts,
    nextAccounts: existing === undefined
      ? [...accounts, {
          id: accountId,
          default: accounts.length === 0,
          email: normalizedEmail,
          phone: normalizedPhone,
        }]
      : accounts.map((account) => account.id === accountId
          ? {
              ...account,
              id: accountId,
              default: account.default,
              ...(normalizedEmail === undefined ? { email: undefined } : { email: normalizedEmail }),
              ...(normalizedPhone === undefined ? { phone: undefined } : { phone: normalizedPhone }),
            }
          : account),
    mode,
    reconfigure,
    paths,
    downloadsCatalog: existing !== undefined || !existsSync(paths.catalogPath),
    updatesExternalAgent: false,
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
    catalog: createOpencodeGoCatalog(downloaded.catalog),
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

async function preserveInitialFiles(paths, accountId) {
  const backup = join(paths.providerDirectory, definition.backupDirectoryName);
  const statePath = join(backup, "state.json");
  if (existsSync(statePath)) return;
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const state = {
    version: 2,
    accountId,
    config: await backupOptional(paths.configPath, join(backup, "config.toml")),
    profile: await backupOptional(
      paths.profilePath,
      join(backup, opencodeGoProfileFileName(accountId)),
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
  const content = await readOptionalProviderFile(source);
  if (content === undefined) return false;
  await writePrivateFileAtomic(target, content);
  return true;
}

async function readTomlFile(path) {
  const content = await readOptionalProviderFile(path);
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全读取或解析");
  }
}

async function assertProfileOwnership(paths, accountId, environment) {
  const profile = await readOptionalProviderFile(paths.profilePath);
  const marker = readOpencodeGoAccountMarker(environment, accountId);
  if (profile === undefined && marker === undefined) return;
  if (marker === undefined) {
    throw new Error(
      `OpenCode Go 账户管理标记不存在，拒绝覆盖现有 Profile：${paths.profilePath}`,
    );
  }
}

export async function readOpencodeGoOptionalJson(path, label) {
  const content = await readOptionalProviderFile(path);
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
    || typeof migration.from !== "string"
    || typeof migration.to !== "string"
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

export function configuredWindowPercentByModel(environment) {
  return Object.fromEntries(
    loadManagedModelWindow(environment)
      .filter((entry) => entry.windowPercent !== undefined)
      .map((entry) => [entry.model, entry.windowPercent]),
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
