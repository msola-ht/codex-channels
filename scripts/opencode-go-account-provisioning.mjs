import { randomUUID } from "node:crypto";
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
  loadOpencodeGoAccountCredentialFor,
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
import { createOpencodeGoCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import {
  createManagedProviderConfiguration,
  createManagedProviderCatalog,
  resolveManagedCatalogModel,
} from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { assertManagedAccountMode, snapshotManagedAccountFiles, managedAccountRevision, assertManagedAccountRevision } from "./managed-provider-account-plan.mjs";
import {
  opencodeGoAccountPaths,
} from "./opencode-go-account-files.mjs";
import {
  assertProviderFileSnapshots,
  readOptionalProviderFile,
  refreshProviderFileSnapshot,
  replaceOptionalProviderFile,
  restoreProviderFileSnapshots,
  snapshotProviderFiles,
  stageManagedPrimaryCredential,
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
  { accountId, email, phone, contact, mode, reconfigure = false, apiKey },
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadPrimaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  return publicPreview(await buildPlan({ accountId, email, phone, contact, mode, reconfigure, apiKey }, {
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
    mode,
    reconfigure = false,
    email,
    phone,
    contact,
    apiKey,
    expectedRevision,
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
  const plan = await buildPlan({ accountId, email, phone, contact, mode, reconfigure, apiKey }, {
    environment,
    loadAccounts,
    loadPrimaryProvider,
  });
  mode = plan.mode;
  assertManagedAccountRevision(expectedRevision, plan.revision);
  if (plan.willChange && (plan.mode === "exclusive" || plan.previousMode === "exclusive") && confirmExclusiveConfigChange !== true) {
    throw invalid(
      "confirmation-required",
      "confirmExclusiveConfigChange",
      "修改 Codex 主配置前必须明确确认",
    );
  }

  let catalogState;
  try {
    catalogState = await loadCatalog(plan, { fetchImpl, downloadCatalog, environment });
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
  let managedCatalog;
  try {
    managedCatalog = plan.downloadsCatalog ? createManagedProviderCatalog(
      catalogState.catalog,
      definition,
      {
        previousModels: previous?.models,
      },
    ) : catalogState.catalog;
    await validateModelCatalogWithCodex(managedCatalog, environment);
  } catch (error) {
    throw normalize("catalog-invalid", "catalog", error);
  }
  const selectedModel = resolveManagedCatalogModel(
    managedCatalog,
    definition,
    previous?.model,
  );
  if (!plan.willChange) {
    await assertProviderFileSnapshots(plan.snapshots);
    return { ...publicPreview(plan), action: "unchanged", paths: publicPaths(plan.paths), model: selectedModel };
  }
  const previousMode = readOpencodeGoAccountMarker(environment, accountId)?.mode;
  if (previousMode === "exclusive" && confirmExclusiveConfigChange !== true) {
    throw invalid(
      "confirmation-required",
      "confirmExclusiveConfigChange",
      "恢复 Codex 主配置前必须明确确认",
    );
  }
  const entersExclusiveMode = previousMode === "switching" && mode === "exclusive";
  const capturesExclusiveBaseline = mode === "exclusive"
    && (previous === undefined || entersExclusiveMode);
  const exclusiveBaselinePath = join(plan.paths.backupDirectory, "config.toml");
  const archivedBaselinePath = capturesExclusiveBaseline && existsSync(exclusiveBaselinePath)
    ? join(plan.paths.backupDirectory, `config-${randomUUID()}.toml`)
    : undefined;
  const snapshots = plan.snapshots;
  try {
    if (archivedBaselinePath !== undefined) {
      snapshots.push(...snapshotProviderFiles([archivedBaselinePath], environment));
    }
    await assertProviderFileSnapshots(snapshots);
  } catch (error) {
    throw normalize("operation-failed", "action", error);
  }
  let guards = snapshots;
  try {
    await assertProviderFileSnapshots(guards);
    mkdirSync(plan.paths.accountDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(plan.paths.backupDirectory, { recursive: true, mode: 0o700 });
    const currentConfig = await readTomlFile(plan.paths.configPath, environment);
    const accountBaseline = existsSync(exclusiveBaselinePath)
      ? await readTomlFile(exclusiveBaselinePath, environment)
      : undefined;
    if (previousMode === "exclusive" && accountBaseline === undefined) {
      throw new Error("OpenCode Go 固定账户恢复基线缺失");
    }
    const initialConfig = capturesExclusiveBaseline
      ? currentConfig
      : accountBaseline ?? currentConfig;
    const { config: nextConfig, profile, credential } = createManagedProviderConfiguration(
      currentConfig,
      initialConfig,
      opencodeGoAccountDefinition(accountId, plan.account.email, plan.account.phone),
      {
        mode,
        previousMode,
        previousProfile: snapshots.find(item => item.path === plan.paths.profilePath)?.content?.toString("utf8"),
        apiKey: plan.apiKey, catalogPath: plan.paths.catalogPath, catalog: managedCatalog, model: selectedModel,
      },
    );
    const profileContent = profile === undefined ? undefined : stringify(profile);
    const credentialUpdates = new Map();
    stageManagedPrimaryCredential(credential, opencodeGoAccountDefinition(accountId, plan.account.email, plan.account.phone), environment, snapshots, credentialUpdates);
    guards = snapshots;
    for (const [path, content] of credentialUpdates) {
      await assertProviderFileSnapshots(guards);
      await replaceOptionalProviderFile(path, content, environment);
      guards = refreshProviderFileSnapshot(guards, path);
    }
    if (archivedBaselinePath !== undefined) {
      const previousBaseline = await readOptionalProviderFile(exclusiveBaselinePath, environment);
      if (previousBaseline === undefined) throw new Error("OpenCode Go 固定账户恢复基线缺失");
      await assertProviderFileSnapshots(guards);
      await writePrivateFileAtomic(archivedBaselinePath, previousBaseline);
      guards = refreshProviderFileSnapshot(guards, archivedBaselinePath);
    }
    if (capturesExclusiveBaseline) {
      await assertProviderFileSnapshots(guards);
      await writePrivateFileAtomic(exclusiveBaselinePath, stringify(initialConfig));
      guards = refreshProviderFileSnapshot(guards, exclusiveBaselinePath);
    }
    if (plan.downloadsCatalog) {
      await assertProviderFileSnapshots(guards);
      await writePrivateFileAtomic(plan.paths.catalogPath, `${JSON.stringify(managedCatalog, null, 2)}\n`);
      guards = refreshProviderFileSnapshot(guards, plan.paths.catalogPath);
      await assertProviderFileSnapshots(guards);
      await replaceOptionalProviderFile(
        plan.paths.manifestPath,
        `${JSON.stringify(catalogState.manifest, null, 2)}\n`,
        environment,
      );
      guards = refreshProviderFileSnapshot(guards, plan.paths.manifestPath);
    }
    await assertProviderFileSnapshots(guards);
    if (mode === "exclusive" || previousMode === "exclusive") {
      await guards.find(snapshot => snapshot.path === plan.paths.configPath).writeCurrent(stringify(nextConfig));
      guards = refreshProviderFileSnapshot(guards, plan.paths.configPath);
    }
    await assertProviderFileSnapshots(guards);
    await replaceOptionalProviderFile(plan.paths.profilePath, profileContent, environment);
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
  { accountId, email, phone, contact, mode, reconfigure, apiKey },
  { environment, loadAccounts, loadPrimaryProvider },
) {
  try {
    validateOpencodeGoAccountId(accountId);
  } catch (error) {
    throw normalize("invalid-account-id", "accountId", error);
  }
  if (typeof reconfigure !== "boolean") {
    throw invalid("invalid-input", "reconfigure", "reconfigure 必须为布尔值");
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
  if (existing === undefined && reconfigure === true) {
    throw invalid("account-not-found", "accountId", `OpenCode Go 账户不存在：${accountId}`);
  }
  let previousMode;
  if (existing !== undefined) {
    try {
      const configured = loadManagedModelProviderSettings(environment)
        .find((provider) => provider.provider === opencodeGoProviderId(accountId));
      if (configured === undefined) throw new Error("OpenCode Go 账户配置不完整，请先恢复缺失文件");
      if (!configured.models.some(model => model.model === configured.model)) {
        throw invalid("account-default-model-missing", "model", "账户默认模型不在当前目录中，请先在模型管理中设置有效的账户默认模型");
      }
      previousMode = configured.mode;
    } catch (error) {
      throw normalize("provider-state-unavailable", "accountId", error);
    }
  }
  if (mode === undefined) mode = previousMode ?? "switching";
  if (mode !== "switching" && mode !== "exclusive") {
    throw invalid("invalid-mode", "mode", "OpenCode Go 账户管理模式无效");
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
  assertManagedAccountMode(mode, opencodeGoAccountDefinition(accountId), environment, loadPrimaryProvider);
  const paths = opencodeGoAccountPaths(environment, accountId);
  let snapshots;
  try {
    // Keep the files that produced this plan across every asynchronous wait.
    // A later snapshot must not accept external changes as the rollback baseline.
    snapshots = snapshotManagedAccountFiles([
      paths.configPath,
      paths.profilePath,
      paths.markerPath,
      paths.catalogPath,
      paths.manifestPath,
      join(paths.backupDirectory, "config.toml"),
      opencodeGoAccountsFilePath(environment),
    ], opencodeGoAccountDefinition(accountId), environment);
  } catch (error) {
    throw normalize("operation-failed", "action", error);
  }
  try {
    await assertProfileOwnership(paths, accountId, environment);
  } catch (error) {
    throw normalize("profile-conflict", "accountId", error);
  }
  const preservesApiKey = apiKey === undefined;
  let currentApiKey;
  if (existing !== undefined) {
    try { currentApiKey = loadOpencodeGoAccountCredentialFor(opencodeGoProviderId(accountId), environment); }
    catch {
      if (preservesApiKey) throw invalid("invalid-api-key", "apiKey", "现有 API Key 无法安全读取，请显式填写新 Key");
    }
  }
  if (preservesApiKey) apiKey = currentApiKey;
  if (typeof apiKey !== "string" || !/^sk-[^\s"]+$/u.test(apiKey) || apiKey.length > 4_096) {
    throw invalid("invalid-api-key", "apiKey", "OpenCode Go API Key 无效；新增账户必须填写 Key");
  }
  await assertProviderFileSnapshots(snapshots);
  return {
    apiKey,
    credentialAction: apiKey === currentApiKey ? "preserve" : "replace",
    willChange: existing === undefined || apiKey !== currentApiKey || mode !== previousMode
      || normalizedEmail !== existing.email || normalizedPhone !== existing.phone,
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
    previousMode,
    paths,
    snapshots,
    revision: managedAccountRevision(snapshots),
    downloadsCatalog: !existsSync(paths.catalogPath),
    updatesExternalAgent: false,
  };
}

async function loadCatalog(plan, { fetchImpl, downloadCatalog, environment }) {
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
  const { catalog, templateBindings } = createOpencodeGoCatalogWithTemplateBindings(downloaded.catalog, environment);
  return {
    catalog,
    manifest: {
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: new Date().toISOString(),
      modelTemplates: templateBindings,
    },
  };
}

function publicPreview(plan) {
  return {
    revision: plan.revision,
    operation: plan.account.exists ? "reconfigure" : "add",
    account: plan.account,
    mode: plan.mode,
    previousMode: plan.previousMode,
    credentialAction: plan.credentialAction,
    willChange: plan.willChange,
    effects: {
      writesMainConfig: plan.willChange && (plan.mode === "exclusive" || plan.previousMode === "exclusive"),
      writesIsolatedProfile: plan.willChange && plan.mode === "switching",
      downloadsCatalog: plan.downloadsCatalog,
      updatesExternalAgent: plan.updatesExternalAgent,
    },
    confirmation: {
      required: plan.willChange && (plan.mode === "exclusive" || plan.previousMode === "exclusive"),
      field: "confirmExclusiveConfigChange",
    },
    activation: plan.willChange ? "restart-all" : "none",
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

async function readTomlFile(path, environment) {
  const content = await readOptionalProviderFile(path, environment);
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全读取或解析");
  }
}

async function assertProfileOwnership(paths, accountId, environment) {
  const profile = await readOptionalProviderFile(paths.profilePath, environment);
  const marker = readOpencodeGoAccountMarker(environment, accountId);
  if (profile === undefined && marker === undefined) return;
  if (marker === undefined) {
    throw new Error(
      `OpenCode Go 账户管理标记不存在，拒绝覆盖现有 Profile：${paths.profilePath}`,
    );
  }
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
