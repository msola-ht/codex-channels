import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import {
  inspectAppServerSupervisorState,
  releaseAppServerProvider,
} from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
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
  assertOpencodeGoFileSnapshots,
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
  readOptionalOpencodeGoFile,
  removeOptionalOpencodeGoFile,
  refreshOpencodeGoFileSnapshot,
  restoreOpencodeGoFileSnapshots,
  snapshotOpencodeGoFiles,
} from "./opencode-go-account-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { runtimeConfig } from "./runtime-config.mjs";

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
  let release;
  try {
    release = await releaseProvider(plan.primarySocketPath, plan.provider);
  } catch (error) {
    throw invalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const action = release.reason === "released"
    ? "stopped"
    : release.reason === "leased"
      ? "in-use"
      : "not-running";
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
    resolvePrimarySocket = defaultPrimarySocket,
    inspectSupervisor = inspectAppServerSupervisorState,
  } = {},
) {
  return publicRemovalPreview(await buildRemovalPlan(accountId, {
    environment,
    loadAccounts,
    loadRole,
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
    writeAccounts = writeOpencodeGoAccounts,
    removeAccounts = removeOptionalOpencodeGoFile,
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
    const profile = await readOptionalOpencodeGoFile(paths.profilePath);
    if (profile !== undefined) {
      await writePrivateFileAtomic(
        join(paths.backupDirectory, opencodeGoProfileFileName(plan.account.id)),
        profile,
      );
    }
    const marker = await readOptionalOpencodeGoFile(paths.markerPath);
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
    const snapshots = snapshotOpencodeGoFiles(transactionPaths);
    let guards = snapshots;
    try {
      await assertOpencodeGoFileSnapshots(guards);
      writeAccounts(environment, plan.remainingAccounts);
      guards = refreshOpencodeGoFileSnapshot(
        guards,
        opencodeGoAccountsFilePath(environment),
      );
      await assertOpencodeGoFileSnapshots(guards);
      if (existsSync(paths.profilePath)) unlinkSync(paths.profilePath);
      guards = refreshOpencodeGoFileSnapshot(guards, paths.profilePath);
      await assertOpencodeGoFileSnapshots(guards);
      if (existsSync(paths.markerPath)) unlinkSync(paths.markerPath);
    } catch (error) {
      try {
        await restoreOpencodeGoFileSnapshots(snapshots, guards);
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
  const accounts = loadAccountsSafely(loadAccounts, environment);
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
  let primarySocketPath;
  let inspection;
  try {
    primarySocketPath = resolvePrimarySocket(environment);
    inspection = await inspectSupervisor(primarySocketPath);
  } catch (error) {
    throw invalid(
      "supervisor-unavailable",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (inspection.status === "incompatible") {
    throw invalid(
      "supervisor-incompatible",
      "action",
      "App Server 监管协议不兼容或响应无效；请先运行 codexc service restart app-server",
    );
  }
  const provider = opencodeGoProviderId(normalizedId);
  const running = inspection.status === "ready"
    && inspection.topology.runningProviders.includes(provider);
  return { accountId: normalizedId, provider, primarySocketPath, running };
}

async function buildRemovalPlan(
  accountId,
  { environment, loadAccounts, loadRole, resolvePrimarySocket, inspectSupervisor },
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
  let mode = null;
  if (removesLastAccount) {
    let marker;
    try {
      marker = readOpencodeGoAccountMarker(environment, normalizedId);
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
    mode = marker.mode;
    if (mode === "exclusive") {
      const initialConfig = await readOptionalOpencodeGoFile(
        join(paths.providerDirectory, "backup", "config.toml"),
      );
      if (initialConfig === undefined) {
        throw invalid(
          "backup-unavailable",
          "accountId",
          "删除最后一个 OpenCode Go 固定账户需要安装前配置备份；未找到备份，无法安全恢复官方主配置",
        );
      }
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
  let promotedDefaultAccountId = null;
  if (!removesLastAccount && account.default && remainingAccounts.length > 0) {
    remainingAccounts[0] = { ...remainingAccounts[0], default: true };
    promotedDefaultAccountId = remainingAccounts[0].id;
  }
  return {
    account,
    accounts,
    remainingAccounts,
    promotedDefaultAccountId,
    removesLastAccount,
    mode,
    restoresInitialConfig: removesLastAccount && mode === "exclusive",
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
    ? await readOptionalOpencodeGoFile(
      join(paths.providerDirectory, "backup", "config.toml"),
    )
    : undefined;
  const initialRoleConfig = plan.restoresInitialConfig
    ? await readOptionalOpencodeGoFile(
      join(paths.providerDirectory, "backup", "sf-agent.config.toml"),
    )
    : undefined;
  const initialCatalog = plan.restoresInitialConfig
    ? await readOptionalOpencodeGoFile(
      join(paths.providerDirectory, "backup", "models.json"),
    )
    : undefined;
  const initialManifest = plan.restoresInitialConfig
    ? await readOptionalOpencodeGoFile(
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
  if (initialRoleConfig !== undefined) transactionPaths.push(paths.roleConfigPath);
  if (plan.removesManagedCatalog) transactionPaths.push(paths.catalogPath, paths.manifestPath);
  const snapshots = snapshotOpencodeGoFiles(transactionPaths);
  let guards = snapshots;
  try {
    await assertOpencodeGoFileSnapshots(guards);
    if (plan.restoresInitialConfig) {
      await writePrivateFileAtomic(paths.configPath, initialConfig);
      guards = refreshOpencodeGoFileSnapshot(guards, paths.configPath);
      await assertOpencodeGoFileSnapshots(guards);
    }
    if (initialRoleConfig !== undefined) {
      await writePrivateFileAtomic(paths.roleConfigPath, initialRoleConfig);
      guards = refreshOpencodeGoFileSnapshot(guards, paths.roleConfigPath);
      await assertOpencodeGoFileSnapshots(guards);
    }
    await removeAccounts(opencodeGoAccountsFilePath(environment));
    guards = refreshOpencodeGoFileSnapshot(
      guards,
      opencodeGoAccountsFilePath(environment),
    );
    await assertOpencodeGoFileSnapshots(guards);
    if (existsSync(paths.profilePath)) {
      await removeOptionalOpencodeGoFile(paths.profilePath);
    }
    guards = refreshOpencodeGoFileSnapshot(guards, paths.profilePath);
    await assertOpencodeGoFileSnapshots(guards);
    if (existsSync(paths.markerPath)) {
      await removeOptionalOpencodeGoFile(paths.markerPath);
    }
    guards = refreshOpencodeGoFileSnapshot(guards, paths.markerPath);
    await assertOpencodeGoFileSnapshots(guards);
    if (plan.removesManagedCatalog) {
      if (initialCatalog !== undefined) {
        await writePrivateFileAtomic(paths.catalogPath, initialCatalog);
      } else if (existsSync(paths.catalogPath)) {
        await removeOptionalOpencodeGoFile(paths.catalogPath);
      }
      guards = refreshOpencodeGoFileSnapshot(guards, paths.catalogPath);
      await assertOpencodeGoFileSnapshots(guards);
      if (initialManifest !== undefined) {
        await writePrivateFileAtomic(paths.manifestPath, initialManifest);
      } else if (existsSync(paths.manifestPath)) {
        await removeOptionalOpencodeGoFile(paths.manifestPath);
      }
      guards = refreshOpencodeGoFileSnapshot(guards, paths.manifestPath);
      await assertOpencodeGoFileSnapshots(guards);
    }
  } catch (error) {
    try {
      await restoreOpencodeGoFileSnapshots(snapshots, guards);
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
    if (plan.restoresInitialConfig) effects.restoresInitialConfig = true;
  }
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

function defaultPrimarySocket(environment) {
  const { configPath, dataDir } = runtimeConfig(environment);
  return resolvePrimaryAppServerSocketPath(readGatewayConfig(configPath), dataDir);
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

function loadAccountsSafely(loadAccounts, environment) {
  try {
    return loadAccounts(environment);
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
