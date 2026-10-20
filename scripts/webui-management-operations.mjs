import { projectProviderManagementState } from "./webui-management-providers.mjs";
import { managedSettingKinds } from "./webui-management-settings.mjs";
import { CodexUserSettingsError } from "./codex-user-settings-management.mjs";

export class ManagementOperationError extends Error {
  constructor(code, message, field = undefined, status = managementErrorStatus(code), cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagementOperationError";
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

/** The read budget includes connection setup; cleanup still retains its owner. */
export async function readManagementSnapshot(request, response, state, read) {
  const controller = new AbortController();
  const deadline = Date.now() + 20_000;
  const disconnect = () => { if (!response.writableEnded) controller.abort(); };
  const timer = setTimeout(() => controller.abort(), 20_000);
  response?.once("close", disconnect);
  if (request?.aborted || response?.destroyed || state.snapshotReadsClosed) controller.abort();
  const entry = { controller, settled: undefined };
  state.snapshotReads.add(entry);
  const task = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    const result = await read(controller.signal);
    if (Date.now() >= deadline) controller.abort();
    controller.signal.throwIfAborted();
    return result;
  });
  entry.settled = task.then(() => undefined, () => undefined);
  try {
    return await task;
  } finally {
    clearTimeout(timer);
    response?.removeListener("close", disconnect);
    state.snapshotReads.delete(entry);
  }
}

export async function closeManagementSnapshotReads(state) {
  state.snapshotReadsClosed = true;
  const entries = [...state.snapshotReads];
  for (const entry of entries) entry.controller.abort();
  await Promise.all(entries.map(entry => entry.settled));
}

export function codexManagementError(error) {
  return managementOperationError(error, [CodexUserSettingsError], "codex_settings_failed");
}

export function assertManagementAuditWritable(audit) {
  try {
    audit.assertWritable();
  } catch (error) {
    throw new ManagementOperationError("management_audit_unavailable", "设置未写入，审计记录不可用；请检查 Gateway 数据目录权限和磁盘空间", undefined, 500, error);
  }
}

/** Only explicitly owned domain errors carry public codes; upstream messages never cross HTTP. */
export function managementOperationError(error, domainErrors, fallbackCode) {
  if (error instanceof ManagementOperationError) return error;
  if (domainErrors.some((type) => error instanceof type)) {
    const status = managementErrorStatus(error.code);
    const message = status === 409 ? "配置状态已变化或存在冲突，请重新读取并核对后操作"
      : status === 404 ? "目标配置或账户不存在，请重新读取"
      : status === 503 ? "管理依赖暂不可用，请检查服务状态及配置文件"
      : status === 500 ? "管理操作结果未确认，请先重新读取配置并核对，勿直接重试写入"
      : "管理操作参数无效，请检查对应字段及当前配置";
    return new ManagementOperationError(error.code, message, error.field, status, error);
  }
  return new ManagementOperationError(fallbackCode, "管理操作结果未确认，请先重新读取配置并核对，勿直接重试写入", undefined, 500, error);
}

function managementErrorStatus(code) {
  if (code === "template-source-unavailable") return 503;
  if (["stale-revision", "stale-preview", "stale-model-probe", "account-exists", "provider-exists", "default-account-conflict", "primary-provider-conflict", "permission-conflict", "context-followers-conflict", "config-path-conflict", "profile-conflict", "window-conflict", "other-switching-providers", "account-runtime-in-use"].includes(code)) return 409;
  if (["account-not-found", "provider-not-found", "provider-not-configured"].includes(code)) return 404;
  if (["provider_state_unavailable", "account_state_unavailable", "provider-state-unavailable", "account-state-unavailable", "supervisor-unavailable", "supervisor-incompatible", "backup-unavailable", "catalog-unavailable", "catalog-invalid", "official-models-unavailable", "acceleration-unavailable", "approvals-reviewer-unavailable"].includes(code)) return 503;
  if (["operation-failed", "rollback-failed", "stop-failed", "write-failed", "save-unconfirmed", "readback-failed"].includes(code)) return 500;
  return 400;
}

export function isHighRiskManagementPath(path) {
  // Relay previews issue a confirmation token but do not apply the mutation.
  // They retain the ordinary POST budget without spending the apply budget.
  if (path === "/relay/preview") return false;
  return path.startsWith("/accounts/openai/reset-credits/")
    || path === "/models/official/context"
    || path === "/models/official/refresh"
    || path.startsWith("/relay/")
    || path.startsWith("/delivery/")
    || path.startsWith("/provider-settings")
    || path.startsWith("/account-settings")
    || path.startsWith("/tasks");
}

export function assertManagedSetting(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !managedSettingKinds.has(input.kind)) {
    throw new ManagementOperationError("setting_not_allowed", "该设置暂不支持 WebUI 修改");
  }
}

const PROVIDER_STATE_CACHE_TTL_MS = 5_000;

export async function loadProviderManagementSummary(environment, state, signal) {
  signal.throwIfAborted();
  const cache = state.providerStateCache;
  const now = Date.now();
  if (cache.value !== null && cache.expiresAtMs > now) return cache.value;
  if (cache.pending === null) {
    const generation = cache.generation ?? 0;
    const entry = { controller: new AbortController(), subscribers: 0, promise: undefined };
    entry.promise = readManagementSnapshot(undefined, undefined, state, async budgetSignal => {
      const sharedSignal = globalThis.AbortSignal.any([budgetSignal, entry.controller.signal]);
      const loaded = await state.loadProviderState({ environment, signal: sharedSignal });
      sharedSignal.throwIfAborted();
      return projectProviderManagementState(loaded);
    }).then(value => {
      entry.controller.signal.throwIfAborted();
      if (state.snapshotReadsClosed) throw new Error("管理快照读取正在关闭");
      if ((cache.generation ?? 0) === generation) {
        cache.value = value;
        cache.expiresAtMs = Date.now() + PROVIDER_STATE_CACHE_TTL_MS;
      }
      return value;
    }).finally(() => {
      if (cache.pending === entry) cache.pending = null;
    });
    cache.pending = entry;
  }
  const entry = cache.pending;
  entry.subscribers += 1;
  let abort;
  try {
    return await Promise.race([
      entry.promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
    entry.subscribers -= 1;
    if (entry.subscribers === 0) {
      entry.controller.abort();
      if (cache.pending === entry) cache.pending = null;
    }
  }
}

export function invalidateProviderManagementSummary(cache) {
  cache.generation = (cache.generation ?? 0) + 1;
  cache.value = null;
  cache.expiresAtMs = 0;
  cache.pending = null;
}
