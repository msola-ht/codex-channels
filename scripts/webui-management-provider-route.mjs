import { loadDeepseekAccounts, deepseekAccountIdFromProvider } from "../runtime/deepseek-accounts.mjs";
import {
  GatewayAccountRefreshError,
} from "../runtime/gateway-account-refresh.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountDisplayName,
  opencodeGoProviderId,
} from "../runtime/opencode-go-accounts.mjs";
import {
  normalizeAccountSettingsMutation,
  redactAccountSettingsResult,
} from "./webui-account-settings-management.mjs";
import { ApiError, readJsonBody, sendJson, sendManagementJson } from "./webui-http.mjs";
import {
  invalidateProviderManagementSummary,
  loadProviderManagementSummary,
  ManagementOperationError,
} from "./webui-management-operations.mjs";
import {
  loadProviderSettingsResource,
  normalizeProviderSettingsMutation,
  redactProviderSettingsResult,
} from "./webui-provider-settings-management.mjs";
import { invalidateServiceStatusSummary } from "./webui-service-status.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";

export async function routeProviderManagement({
  configPath,
  environment,
  maximumBodyBytes,
  openMetricsStore,
  path,
  principalId,
  request,
  response,
  state,
}) {
  if (path === "/accounts/refresh" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (
      !body
      || typeof body !== "object"
      || Array.isArray(body)
      || typeof body.provider !== "string"
      || Object.keys(body).some((key) => key !== "provider")
    ) {
      throw new ApiError(400, "invalid_account_refresh", "账户刷新请求必须包含唯一的 provider 字段");
    }
    try {
      await state.refreshGatewayAccount(configPath, body.provider);
    } catch (error) {
      if (error instanceof GatewayAccountRefreshError) {
        if (error.code === "provider_not_found") throw new ApiError(404, error.code, error.message);
        if (error.code === "invalid_request") throw new ApiError(400, error.code, error.message);
        throw new ApiError(
          error.code === "refresh_failed" ? 502 : 503,
          error.code,
          error.message,
        );
      }
      throw new ApiError(503, "gateway_unavailable", "Gateway 账户刷新接口不可用");
    }
    sendAccountSnapshots(environment, response, openMetricsStore);
    return true;
  }
  if (path === "/provider-settings" && request.method === "GET") {
    const resource = await readProviderSettings(environment, state);
    sendManagementJson(response, 200, {
      observedAt: new Date().toISOString(),
      resourceRevision: fingerprintManagementValue(resource),
      ...resource,
    });
    return true;
  }
  if (path === "/account-settings" && request.method === "GET") {
    const resource = await readAccountSettings(environment, state);
    sendManagementJson(response, 200, {
      observedAt: new Date().toISOString(),
      resourceRevision: fingerprintManagementValue(resource),
      ...resource,
    });
    return true;
  }
  if (path === "/account-settings/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    const input = normalizeAccountSettingsMutation(body);
    const preview = await state.previewAccountSettings(input, environment);
    const safePreview = redactAccountSettingsResult(preview);
    const resource = await readAccountSettings(environment, state);
    const inputFingerprint = fingerprintManagementValue(input);
    const resourceRevision = fingerprintManagementValue(resource);
    const issued = state.confirmations.issue({
      sessionId: principalId,
      operation: "account-settings.write",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(safePreview),
    });
    sendManagementJson(response, 200, {
      preview: safePreview,
      resourceRevision,
      confirmationToken: issued.token,
      confirmationExpiresAt: issued.expiresAt,
    });
    return true;
  }
  if (path === "/account-settings" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.confirmationToken !== "string") {
      throw new ApiError(400, "invalid_json", "账户设置写入请求必须包含 confirmationToken");
    }
    const input = normalizeAccountSettingsMutation(body);
    const resource = await readAccountSettings(environment, state);
    const preview = await state.previewAccountSettings(input, environment);
    const safePreview = redactAccountSettingsResult(preview);
    const inputFingerprint = fingerprintManagementValue(input);
    const resourceRevision = fingerprintManagementValue(resource);
    state.confirmations.consume(body.confirmationToken, {
      sessionId: principalId,
      operation: "account-settings.write",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(safePreview),
    });
    let result;
    try {
      state.audit.assertWritable();
      result = await state.applyAccountSettings(input, environment, safePreview);
    } catch (error) {
      throw error instanceof ManagementOperationError
        ? error
        : new ApiError(400, "account_settings_write_failed", error instanceof Error ? error.message : "账户设置写入失败");
    }
    invalidateProviderManagementSummary(state.providerStateCache);
    invalidateServiceStatusSummary(state.serviceStatusCache);
    const auditStatus = recordProviderAudit(state, {
      sessionId: principalId,
      operation: "account-settings.write",
      target: accountSettingsAuditTarget(input),
      inputFingerprint,
      resourceRevision,
      safePreview,
      confirmationToken: body.confirmationToken,
      resultCode: result.action ?? "updated",
    }, "账户设置已写入，但审计记录失败");
    sendManagementJson(response, 200, { ...redactAccountSettingsResult(result), auditStatus });
    return true;
  }
  if (path === "/provider-settings/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    const input = normalizeProviderSettingsMutation(body);
    const preview = await state.previewProviderSettings(input, environment);
    const safePreview = redactProviderSettingsResult(preview);
    const resource = await readProviderSettings(environment, state);
    const inputFingerprint = fingerprintManagementValue(input);
    const resourceRevision = fingerprintManagementValue(resource);
    const issued = state.confirmations.issue({
      sessionId: principalId,
      operation: "provider-settings.write",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(safePreview),
    });
    sendManagementJson(response, 200, {
      preview: safePreview,
      resourceRevision,
      confirmationToken: issued.token,
      confirmationExpiresAt: issued.expiresAt,
    });
    return true;
  }
  if (path === "/provider-settings" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.confirmationToken !== "string") {
      throw new ApiError(400, "invalid_json", "Provider 设置写入请求必须包含 confirmationToken");
    }
    const input = normalizeProviderSettingsMutation(body);
    const resource = await readProviderSettings(environment, state);
    const preview = await state.previewProviderSettings(input, environment);
    const safePreview = redactProviderSettingsResult(preview);
    const inputFingerprint = fingerprintManagementValue(input);
    const resourceRevision = fingerprintManagementValue(resource);
    state.confirmations.consume(body.confirmationToken, {
      sessionId: principalId,
      operation: "provider-settings.write",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(safePreview),
    });
    let result;
    try {
      state.audit.assertWritable();
      result = await state.applyProviderSettings(input, environment, safePreview);
    } catch (error) {
      throw error instanceof ManagementOperationError
        ? error
        : new ApiError(400, "provider_settings_write_failed", error instanceof Error ? error.message : "Provider 设置写入失败");
    }
    invalidateProviderManagementSummary(state.providerStateCache);
    invalidateServiceStatusSummary(state.serviceStatusCache);
    const auditStatus = recordProviderAudit(state, {
      sessionId: principalId,
      operation: "provider-settings.write",
      target: providerSettingsAuditTarget(input),
      inputFingerprint,
      resourceRevision,
      safePreview,
      confirmationToken: body.confirmationToken,
      resultCode: result.action ?? "updated",
    }, "Provider 设置已写入，但审计记录失败");
    sendManagementJson(response, 200, { ...redactProviderSettingsResult(result), auditStatus });
    return true;
  }
  if (path === "/providers" && request.method === "GET") {
    let providers;
    try {
      providers = await loadProviderManagementSummary(
        environment,
        state.providerStateCache,
        state.loadProviderState,
      );
    } catch {
      throw new ApiError(503, "provider_state_unavailable", "Provider 状态暂不可用，请使用 codexc setup 查看");
    }
    sendManagementJson(response, 200, providers);
    return true;
  }
  return false;
}

export function sendAccountSnapshots(environment, response, openMetricsStore) {
  const store = openMetricsStore(environment);
  try {
    const storedSnapshots = typeof store.latestAccountSnapshots === "function"
      ? store.latestAccountSnapshots()
      : [];
    let accounts = null;
    const warnings = [];
    try {
      accounts = loadOpencodeGoAccounts(environment);
    } catch {
      warnings.push({
        source: "opencode-go",
        code: "registry_unavailable",
        message: "OpenCode Go 账户元数据暂不可用",
      });
    }
    const configuredAccounts = accounts ?? [];
    const dsAccounts = loadDeepseekAccounts(environment);
    const accountById = new Map(configuredAccounts.map((account) => [account.id, account]));
    const snapshots = storedSnapshots
      .filter((snapshot) => {
        if (accounts === null) return true;
        const opencodeGo = snapshot.provider === "ocg"
          || snapshot.provider.startsWith("ocg-");
        return !opencodeGo
          || (snapshot.accountId !== null && accountById.has(snapshot.accountId));
      })
      .map((snapshot) => {
        const dsAccountId = deepseekAccountIdFromProvider(snapshot.provider);
        const dsAccount = dsAccounts.find((entry) => entry.id === dsAccountId);
        const account = !snapshot.provider.startsWith("ocg-") || snapshot.accountId === null
          ? undefined
          : accountById.get(snapshot.accountId);
        return {
          ...snapshot,
          displayName: dsAccount ? `DS ${dsAccount.id}` : account === undefined
            ? snapshot.provider === "deepseek" ? "DeepSeek" : snapshot.provider
            : opencodeGoAccountDisplayName(account),
          default: dsAccount?.default ?? account?.default ?? false,
        };
      });
    for (const account of configuredAccounts) {
      const provider = opencodeGoProviderId(account.id);
      if (snapshots.some((snapshot) => snapshot.provider === provider)) continue;
      snapshots.push({
        provider,
        accountId: account.id,
        observedAtMs: 0,
        available: false,
        usage: { kind: "unsupported", provider },
        limits: { kind: "unsupported", provider },
        displayName: opencodeGoAccountDisplayName(account),
        default: account.default,
      });
    }
    sendJson(response, 200, {
      observedAtMs: snapshots.reduce((latest, item) => Math.max(latest, item.observedAtMs), 0),
      snapshots,
      warnings,
    });
  } finally {
    store.close();
  }
}

function recordProviderAudit(state, details, failureMessage) {
  try {
    state.audit.record({
      sessionId: details.sessionId,
      source: "webui",
      operation: details.operation,
      target: details.target,
      inputFingerprint: details.inputFingerprint,
      revision: details.resourceRevision,
      previewId: fingerprintManagementValue(details.safePreview),
      confirmationId: fingerprintManagementValue(details.confirmationToken),
      phase: "completed",
      resultCode: details.resultCode,
      recovery: "none",
    });
    return "recorded";
  } catch (error) {
    console.error(failureMessage, error);
    return "degraded";
  }
}

function providerSettingsAuditTarget(input) {
  if (input.operation === "primary.custom.save") return String(input.provider?.providerId ?? "unknown");
  if (input.operation === "managed.default") return String(input.provider ?? "unknown");
  if (input.operation === "managed.window") return String(input.model ?? "unknown");
  if (input.operation === "external-agent") return String(input.provider ?? input.action ?? "unknown");
  return String(input.providerId ?? "unknown");
}

function accountSettingsAuditTarget(input) {
  if (input.operation.startsWith("opencode.account.")) return String(input.accountId ?? "unknown");
  return input.operation.startsWith("deepseek.") ? "deepseek" : "unknown";
}

async function readProviderSettings(environment, state) {
  try {
    return await loadProviderSettingsResource(environment, state.loadProviderState);
  } catch {
    throw new ApiError(503, "provider_state_unavailable", "Provider 设置暂不可用，请检查 Codex 配置");
  }
}

async function readAccountSettings(environment, state) {
  try {
    return await state.loadAccountSettings(environment);
  } catch {
    throw new ApiError(503, "account_state_unavailable", "账户设置暂不可用，请检查 Provider 配置");
  }
}
