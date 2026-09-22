import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import {
  inspectAppServerSupervisorState,
  releaseAppServerProvider,
} from "../runtime/app-server-supervisor.mjs";
import { opencodeGoAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProviderRole,
} from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountsFilePath,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";
import {
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
} from "./opencode-go-account-files.mjs";
import {
  assertProviderFileSnapshots,
  readOptionalProviderFile,
  removeOptionalProviderFile,
  refreshProviderFileSnapshot,
  restoreProviderFileSnapshots,
  snapshotProviderFiles,
} from "./managed-provider-files.mjs";
import { restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import {
  managedAccountPrimarySocket as defaultPrimarySocket,
  inspectManagedAccountRuntime,
  releaseManagedAccountRuntime,
} from "./managed-provider-account-runtime.mjs";

export class OpenCodeGoAccountManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "OpenCodeGoAccountManagementError";
    this.code = code;
    this.field = field;
  }
}

export function previewOpencodeGoDefaultAccountChange(
  accountId,
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
  } = {},
) {
  return publicDefaultPreview(buildDefaultPlan(accountId, {
    environment,
    loadAccounts,
  }));
}

export async function applyOpencodeGoDefaultAccountChange(
  accountId,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(
    environment,
    () => applyOpencodeGoDefaultAccountChangeUnlocked(accountId, options),
  );
}

async function applyOpencodeGoDefaultAccountChangeUnlocked(
  accountId,
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    writeAccounts = writeOpencodeGoAccounts,
  } = {},
) {
  const plan = buildDefaultPlan(accountId, { environment, loadAccounts });
  try {
    writeAccounts(environment, plan.nextAccounts);
  } catch (error) {
    if (error instanceof OpenCodeGoAccountManagementError) throw error;
    throw invalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return {
    action: "default-set",
    ...publicDefaultPreview(plan),
  };
}

export async function previewOpencodeGoAccountStop(
  accountId,
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    resolvePrimarySocket = defaultPrimarySocket,
    inspectSupervisor = inspectAppServerSupervisorState,
  } = {},
) {
  return publicStopPreview(await buildStopPlan(accountId, {
    environment,
    loadAccounts,
    resolvePrimarySocket,
    inspectSupervisor,
  }));
}

export async function applyOpencodeGoAccountStop(
  accountId,
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    resolvePrimarySocket = defaultPrimarySocket,
    inspectSupervisor = inspectAppServerSupervisorState,
    releaseProvider = releaseAppServerProvider,
  } = {},
) {
  const plan = await buildStopPlan(accountId, {
    environment,
    loadAccounts,
    resolvePrimarySocket,
    inspectSupervisor,
  });
  if (!plan.running) {
    return { action: "not-running", ...publicStopPreview(plan) };
  }
  let action;
  try {
    action = await releaseManagedAccountRuntime(plan, { releaseProvider });
  } catch (error) {
    throw invalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return {
    action,
    ...publicStopPreview(plan),
    status: action === "stopped" ? "stopped" : action,
    willChange: false,
  };
}

export async function previewOpencodeGoAccountRemoval(
  accountId,
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadRole = loadManagedModelProviderRole,
    readMarker = readOpencodeGoAccountMarker,
    resolvePrimarySocket = defaultPrimarySocket,
    inspectSupervisor = inspectAppServerSupervisorState,
  } = {},
) {
  return publicRemovalPreview(await buildRemovalPlan(accountId, {
    environment,
    loadAccounts,
    loadRole,
    readMarker,
    resolvePrimarySocket,
    inspectSupervisor,
  }));
}

export async function applyOpencodeGoAccountRemoval(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(
    environment,
    () => applyOpencodeGoAccountRemovalUnlocked(input, options),
  );
}

async function applyOpencodeGoAccountRemovalUnlocked(
  {
    accountId,
    confirmHistoryLoss = false,
  },
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadRole = loadManagedModelProviderRole,
    readMarker = readOpencodeGoAccountMarker,
    writeAccounts = writeOpencodeGoAccounts,
    removeAccounts = removeOptionalProviderFile,
    resolvePrimarySocket = defaultPrimarySocket,
    inspectSupervisor = inspectAppServerSupervisorState,
    releaseProvider = releaseAppServerProvider,
    stopAccount = applyOpencodeGoAccountStop,
  } = {},
) {
  const plan = await buildRemovalPlan(accountId, {
    environment,
    loadAccounts,
    loadRole,
    readMarker,
    resolvePrimarySocket,
    inspectSupervisor,
  });
  if (confirmHistoryLoss !== true) {
    throw invalid(
      "confirmation-required",
      "confirmHistoryLoss",
      "删除 OpenCode Go 账户前必须确认历史 Thread 将不可恢复",
    );
  }
  let stopResult;
  try {
    stopResult = await stopAccount(plan.account.id, {
      environment,
      loadAccounts: () => plan.accounts,
      resolvePrimarySocket,
      inspectSupervisor,
      releaseProvider,
    });
  } catch (error) {
    if (error instanceof OpenCodeGoAccountManagementError) throw error;
    throw invalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (stopResult.action === "in-use") {
    throw invalid(
      "account-runtime-in-use",
      "accountId",
      `OpenCode Go 账户 ${plan.account.id} 正在被 Remote TUI 使用；请退出对应 TUI 后再删除`,
    );
  }
  const paths = plan.paths;
  try {
    mkdirSync(paths.backupDirectory, { recursive: true, mode: 0o700 });
    const profile = await readOptionalProviderFile(paths.profilePath);
    if (profile !== undefined) {
      await writePrivateFileAtomic(
        join(paths.backupDirectory, opencodeGoProfileFileName(plan.account.id)),
        profile,
      );
    }
    const marker = await readOptionalProviderFile(paths.markerPath);
    if (marker !== undefined) {
      await writePrivateFileAtomic(join(paths.backupDirectory, "managed.toml"), marker);
    }
    if (plan.removesLastAccount) {
      return applyLastAccountRemovalFiles(plan, {
        environment,
        removeAccounts,
        runtime: stopResult.action,
      });
    }
    const transactionPaths = [
      opencodeGoAccountsFilePath(environment),
      paths.profilePath,
      paths.markerPath,
    ];
    if (plan.restoresInitialConfig) transactionPaths.push(paths.configPath);
    const snapshots = snapshotProviderFiles(transactionPaths);
    let guards = snapshots;
    try {
      await assertProviderFileSnapshots(guards);
      if (plan.restoresInitialConfig) {
        const initialConfig = await readOpencodeGoRestoreBaseline(paths);
        if (initialConfig === undefined) {
          throw new Error("OpenCode Go 固定账户恢复基线缺失");
        }
        await restoreOpencodeGoBaseConfig(plan, initialConfig);
        guards = refreshProviderFileSnapshot(guards, paths.configPath);
        await assertProviderFileSnapshots(guards);
      }
      writeAccounts(environment, plan.remainingAccounts);
      guards = refreshProviderFileSnapshot(
        guards,
        opencodeGoAccountsFilePath(environment),
      );
      await assertProviderFileSnapshots(guards);
      if (existsSync(paths.profilePath)) unlinkSync(paths.profilePath);
      guards = refreshProviderFileSnapshot(guards, paths.profilePath);
      await assertProviderFileSnapshots(guards);
      if (existsSync(paths.markerPath)) unlinkSync(paths.markerPath);
    } catch (error) {
      try {
        await restoreProviderFileSnapshots(snapshots, guards);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "OpenCode Go 账户删除失败，且未能完整恢复操作前文件",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof OpenCodeGoAccountManagementError) throw error;
    throw invalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return {
    action: "removed",
    ...publicRemovalPreview(plan),
    runtime: stopResult.action,
    backupDirectory: paths.backupDirectory,
  };
}

function buildDefaultPlan(accountId, { environment, loadAccounts }) {
  const normalizedId = validAccountId(accountId);
  const accounts = loadAccountsSafely(loadAccounts, environment, {
    allowMissingDefault: true,
  });
  const account = accounts.find((candidate) => candidate.id === normalizedId);
  if (account === undefined) {
    throw invalid(
      "account-not-found",
      "accountId",
      `OpenCode Go 账户不存在：${normalizedId}`,
    );
  }
  const currentDefault = accounts.find((candidate) => candidate.default);
  return {
    account,
    accounts,
    nextAccounts: accounts.map((candidate) => ({
      ...candidate,
      id: candidate.id,
      default: candidate.id === normalizedId,
    })),
    currentDefaultAccountId: currentDefault?.id ?? null,
    updatesExternalAgent: false,
    willChange: account.default !== true,
  };
}

async function buildStopPlan(
  accountId,
  { environment, loadAccounts, resolvePrimarySocket, inspectSupervisor },
) {
  const normalizedId = validAccountId(accountId);
  if (!loadAccountsSafely(loadAccounts, environment)
    .some((candidate) => candidate.id === normalizedId)) {
    throw invalid(
      "account-not-found",
      "accountId",
      `OpenCode Go 账户不存在：${normalizedId}`,
    );
  }
  try {
    return { accountId: normalizedId, ...await inspectManagedAccountRuntime(opencodeGoProviderId(normalizedId), {
      environment, resolvePrimarySocket, inspectSupervisor,
    }) };
  } catch (error) {
    throw invalid(
      error?.code === "supervisor-incompatible" ? error.code : "supervisor-unavailable",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

async function buildRemovalPlan(
  accountId,
  { environment, loadAccounts, loadRole, readMarker, resolvePrimarySocket, inspectSupervisor },
) {
  const normalizedId = validAccountId(accountId);
  const accounts = loadAccountsSafely(loadAccounts, environment);
  const account = accounts.find((candidate) => candidate.id === normalizedId);
  if (account === undefined) {
    throw invalid(
      "account-not-found",
      "accountId",
      `OpenCode Go 账户不存在：${normalizedId}`,
    );
  }
  const paths = opencodeGoAccountPaths(environment, normalizedId);
  const removesLastAccount = accounts.length === 1;
  if (!removesLastAccount && account.default) {
    throw invalid(
      "default-account-conflict",
      "accountId",
      "请先选择其他 OpenCode Go 默认账户",
    );
  }
  let marker;
  try {
    marker = readMarker(environment, normalizedId);
  } catch (error) {
    throw invalid(
      "provider-state-unavailable",
      "accountId",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (marker === undefined) {
    throw invalid(
      "provider-state-unavailable",
      "accountId",
      `OpenCode Go 账户 ${normalizedId} 的管理标记缺失，无法确认运行模式；请先运行 codexc doctor`,
    );
  }
  const mode = marker.mode;
  if (mode === "exclusive") {
    const initialConfig = await readOpencodeGoRestoreBaseline(paths);
    if (initialConfig === undefined) {
      throw invalid(
        "backup-unavailable",
        "accountId",
        "删除 OpenCode Go 固定账户需要进入固定模式前的配置备份；未找到备份，无法安全恢复主配置",
      );
    }
  }
  let role;
  try {
    role = loadRole(environment);
  } catch (error) {
    throw invalid(
      "provider-state-unavailable",
      "accountId",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (role?.provider === opencodeGoProviderId(normalizedId)) {
    throw invalid(
      "account-used-by-agent",
      "accountId",
      removesLastAccount
        ? `OpenCode Go 账户 ${normalizedId} 是 agents.external 当前账户；请先运行 codexc agents disable`
        : `OpenCode Go 账户 ${normalizedId} 是 agents.external 当前账户；请先运行 codexc agents configure ocg-<其他账户> <模型> 或 codexc agents disable`,
    );
  }
  const stop = await previewOpencodeGoAccountStop(normalizedId, {
    environment,
    loadAccounts: () => accounts,
    resolvePrimarySocket,
    inspectSupervisor,
  });
  const remainingAccounts = accounts.filter((candidate) => candidate.id !== normalizedId);
  return {
    account,
    accounts,
    remainingAccounts,
    promotedDefaultAccountId: null,
    removesLastAccount,
    mode,
    restoresInitialConfig: mode === "exclusive",
    removesManagedCatalog: removesLastAccount,
    stop,
    paths,
  };
}

async function applyLastAccountRemovalFiles(
  plan,
  { environment, removeAccounts, runtime },
) {
  const { paths } = plan;
  const initialConfig = plan.restoresInitialConfig
    ? await readOpencodeGoRestoreBaseline(paths)
    : undefined;
  const initialRoleConfig = plan.restoresInitialConfig
    ? await readOptionalProviderFile(
      join(paths.providerDirectory, "backup", "sf-agent.config.toml"),
    )
    : undefined;
  const initialCatalog = plan.restoresInitialConfig
    ? await readOptionalProviderFile(
      join(paths.providerDirectory, "backup", "models.json"),
    )
    : undefined;
  const initialManifest = plan.restoresInitialConfig
    ? await readOptionalProviderFile(
      join(paths.providerDirectory, "backup", "models.manifest.json"),
    )
    : undefined;
  if (plan.restoresInitialConfig && initialConfig === undefined) {
    throw invalid(
      "backup-unavailable",
      "accountId",
      "删除最后一个 OpenCode Go 固定账户需要安装前配置备份；未找到备份，无法安全恢复官方主配置",
    );
  }
  const transactionPaths = [
    opencodeGoAccountsFilePath(environment),
    paths.profilePath,
    paths.markerPath,
  ];
  if (plan.restoresInitialConfig) transactionPaths.push(paths.configPath);
  if (plan.restoresInitialConfig) transactionPaths.push(paths.roleConfigPath);
  if (plan.removesManagedCatalog) transactionPaths.push(paths.catalogPath, paths.manifestPath);
  const snapshots = snapshotProviderFiles(transactionPaths);
  let guards = snapshots;
  try {
    await assertProviderFileSnapshots(guards);
    if (plan.restoresInitialConfig) {
      await restoreOpencodeGoBaseConfig(plan, initialConfig);
      guards = refreshProviderFileSnapshot(guards, paths.configPath);
      await assertProviderFileSnapshots(guards);
    }
    if (plan.restoresInitialConfig) {
      if (initialRoleConfig !== undefined) {
        await writePrivateFileAtomic(paths.roleConfigPath, initialRoleConfig);
      } else if (existsSync(paths.roleConfigPath)) {
        await removeOptionalProviderFile(paths.roleConfigPath);
      }
      guards = refreshProviderFileSnapshot(guards, paths.roleConfigPath);
      await assertProviderFileSnapshots(guards);
    }
    await removeAccounts(opencodeGoAccountsFilePath(environment));
    guards = refreshProviderFileSnapshot(
      guards,
      opencodeGoAccountsFilePath(environment),
    );
    await assertProviderFileSnapshots(guards);
    if (existsSync(paths.profilePath)) {
      await removeOptionalProviderFile(paths.profilePath);
    }
    guards = refreshProviderFileSnapshot(guards, paths.profilePath);
    await assertProviderFileSnapshots(guards);
    if (existsSync(paths.markerPath)) {
      await removeOptionalProviderFile(paths.markerPath);
    }
    guards = refreshProviderFileSnapshot(guards, paths.markerPath);
    await assertProviderFileSnapshots(guards);
    if (plan.removesManagedCatalog) {
      if (initialCatalog !== undefined) {
        await writePrivateFileAtomic(paths.catalogPath, initialCatalog);
      } else if (existsSync(paths.catalogPath)) {
        await removeOptionalProviderFile(paths.catalogPath);
      }
      guards = refreshProviderFileSnapshot(guards, paths.catalogPath);
      await assertProviderFileSnapshots(guards);
      if (initialManifest !== undefined) {
        await writePrivateFileAtomic(paths.manifestPath, initialManifest);
      } else if (existsSync(paths.manifestPath)) {
        await removeOptionalProviderFile(paths.manifestPath);
      }
      guards = refreshProviderFileSnapshot(guards, paths.manifestPath);
      await assertProviderFileSnapshots(guards);
    }
  } catch (error) {
    try {
      await restoreProviderFileSnapshots(snapshots, guards);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "OpenCode Go 最后一个账户删除失败，且未能完整恢复操作前文件",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return {
    action: "removed",
    ...publicRemovalPreview(plan),
    runtime,
    backupDirectory: paths.backupDirectory,
  };
}

async function readOpencodeGoRestoreBaseline(paths) {
  return await readOptionalProviderFile(join(paths.backupDirectory, "config.toml"))
    ?? await readOptionalProviderFile(join(paths.providerDirectory, "backup", "config.toml"));
}

async function restoreOpencodeGoBaseConfig(plan, initialConfig) {
  const currentConfig = await readOptionalProviderFile(plan.paths.configPath);
  const restored = restoreProviderBaseConfig(
    parseConfig(currentConfig),
    parseConfig(initialConfig),
    opencodeGoAccountDefinition(
      plan.account.id,
      plan.account.email,
      plan.account.phone,
    ),
  );
  if (Object.keys(restored).length === 0) {
    if (existsSync(plan.paths.configPath)) {
      await removeOptionalProviderFile(plan.paths.configPath);
    }
  } else {
    await writePrivateFileAtomic(plan.paths.configPath, stringify(restored));
  }
}

function parseConfig(content) {
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("OpenCode Go 固定账户恢复基线无法安全读取");
  }
}

function publicDefaultPreview(plan) {
  return {
    operation: "set-default",
    account: {
      id: plan.account.id,
      default: true,
      ...(plan.account.email === undefined ? {} : { email: plan.account.email }),
      ...(plan.account.phone === undefined ? {} : { phone: plan.account.phone }),
    },
    currentDefaultAccountId: plan.currentDefaultAccountId,
    updatesExternalAgent: plan.updatesExternalAgent,
    willChange: plan.willChange,
    activation: "restart-all",
  };
}

function publicStopPreview(plan) {
  return {
    operation: "stop",
    account: {
      id: plan.accountId,
      provider: plan.provider,
    },
    status: plan.running ? "running" : "not-running",
    willChange: plan.running,
    activation: "none",
  };
}

function publicRemovalPreview(plan) {
  const effects = {
    stopsRunningAppServer: plan.stop.status === "running",
    promotesDefaultAccountId: plan.promotedDefaultAccountId,
    preservesPrivateBackup: true,
    historyThreadsBecomeUnavailable: true,
  };
  if (plan.removesLastAccount) {
    effects.removesLastAccount = true;
    effects.removesManagedCatalog = true;
  }
  if (plan.restoresInitialConfig) effects.restoresInitialConfig = true;
  return {
    operation: "remove",
    account: {
      id: plan.account.id,
      provider: opencodeGoProviderId(plan.account.id),
      default: plan.account.default,
      ...(plan.account.email === undefined ? {} : { email: plan.account.email }),
      ...(plan.account.phone === undefined ? {} : { phone: plan.account.phone }),
    },
    effects,
    confirmation: { required: true, field: "confirmHistoryLoss" },
    activation: "restart-all",
  };
}

function validAccountId(value) {
  try {
    validateOpencodeGoAccountId(value);
    return value;
  } catch (error) {
    throw invalid(
      "invalid-account-id",
      "accountId",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function loadAccountsSafely(loadAccounts, environment, options) {
  try {
    return loadAccounts(environment, options);
  } catch (error) {
    throw invalid(
      "account-state-unavailable",
      "accountId",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function invalid(code, field, message, cause) {
  return new OpenCodeGoAccountManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}
