import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import {
  inspectAppServerSupervisorState,
  releaseAppServerProvider,
} from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { opencodeGoAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { loadManagedModelProviderRole } from "../runtime/model-provider-runtime.mjs";
import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  opencodeGoAccountsFilePath,
  opencodeGoProviderId,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";
import { configureThirdPartyRole } from "./agents.mjs";
import {
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
  readOptionalOpencodeGoFile,
  restoreOpencodeGoFileSnapshots,
  snapshotOpencodeGoFiles,
} from "./opencode-go-account-files.mjs";
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
    loadRole = loadManagedModelProviderRole,
  } = {},
) {
  return publicDefaultPreview(buildDefaultPlan(accountId, {
    environment,
    loadAccounts,
    loadRole,
  }));
}

export async function applyOpencodeGoDefaultAccountChange(
  accountId,
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadRole = loadManagedModelProviderRole,
    writeAccounts = writeOpencodeGoAccounts,
    configureRole = configureThirdPartyRole,
  } = {},
) {
  const plan = buildDefaultPlan(accountId, { environment, loadAccounts, loadRole });
  try {
    writeAccounts(environment, plan.nextAccounts);
    if (plan.updatesExternalAgent) {
      const definition = opencodeGoAccountDefinition(plan.account.id);
      try {
        await configureRole(
          opencodeGoProviderId(plan.account.id),
          definition.defaultModel,
          environment,
        );
      } catch (error) {
        try {
          writeAccounts(environment, plan.accounts);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "共享第三方子代理更新失败，且默认账户回滚失败",
            { cause: rollbackError },
          );
        }
        throw error;
      }
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
  {
    accountId,
    confirmHistoryLoss = false,
  },
  {
    environment = process.env,
    loadAccounts = loadOpencodeGoAccounts,
    loadRole = loadManagedModelProviderRole,
    writeAccounts = writeOpencodeGoAccounts,
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
    const transactionPaths = [
      opencodeGoAccountsFilePath(environment),
      paths.profilePath,
      paths.markerPath,
    ];
    const snapshots = snapshotOpencodeGoFiles(transactionPaths);
    let guards;
    try {
      writeAccounts(environment, plan.remainingAccounts);
      guards = snapshotOpencodeGoFiles(transactionPaths);
      if (existsSync(paths.profilePath)) unlinkSync(paths.profilePath);
      guards = snapshotOpencodeGoFiles(transactionPaths);
      if (existsSync(paths.markerPath)) unlinkSync(paths.markerPath);
    } catch (error) {
      if (guards === undefined) throw error;
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

function buildDefaultPlan(accountId, { environment, loadAccounts, loadRole }) {
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
  const updatesExternalAgent = role !== undefined && isOpencodeGoProvider(role.provider);
  const currentDefault = accounts.find((candidate) => candidate.default);
  return {
    account,
    accounts,
    nextAccounts: accounts.map((candidate) => ({
      id: candidate.id,
      default: candidate.id === normalizedId,
    })),
    currentDefaultAccountId: currentDefault?.id ?? null,
    updatesExternalAgent,
    willChange: account.default !== true
      || (updatesExternalAgent && role.provider !== opencodeGoProviderId(normalizedId)),
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
  if (accounts.length === 1) {
    throw invalid(
      "last-account",
      "accountId",
      "不能删除最后一个 OpenCode Go 账户；请在 Setup 中选择恢复配置",
    );
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
      `OpenCode Go 账户 ${normalizedId} 是 agents.external 当前账户；请先运行 codexc opencode-go account default <其他账户> 或 codexc agents disable`,
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
  if (account.default && remainingAccounts.length > 0) {
    remainingAccounts[0] = { ...remainingAccounts[0], default: true };
    promotedDefaultAccountId = remainingAccounts[0].id;
  }
  return {
    account,
    accounts,
    remainingAccounts,
    promotedDefaultAccountId,
    stop,
    paths: opencodeGoAccountPaths(environment, normalizedId),
  };
}

function publicDefaultPreview(plan) {
  return {
    operation: "set-default",
    account: { id: plan.account.id, default: true },
    currentDefaultAccountId: plan.currentDefaultAccountId,
    updatesExternalAgent: plan.updatesExternalAgent,
    willChange: plan.willChange,
    activation: "restart-all",
  };
}

function publicStopPreview(plan) {
  return {
    operation: "stop",
    account: { id: plan.accountId, provider: plan.provider },
    status: plan.running ? "running" : "not-running",
    willChange: plan.running,
    activation: "none",
  };
}

function publicRemovalPreview(plan) {
  return {
    operation: "remove",
    account: {
      id: plan.account.id,
      provider: opencodeGoProviderId(plan.account.id),
      default: plan.account.default,
    },
    effects: {
      stopsRunningAppServer: plan.stop.status === "running",
      promotesDefaultAccountId: plan.promotedDefaultAccountId,
      preservesPrivateBackup: true,
      historyThreadsBecomeUnavailable: true,
    },
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
