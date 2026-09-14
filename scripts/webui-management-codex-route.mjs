import { configActivationResult } from "./config-activation-result.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import {
  codexManagementError,
  invalidateProviderManagementSummary,
} from "./webui-management-operations.mjs";
import {
  fingerprintManagementValue,
  ManagementSecurityError,
} from "./management-security.mjs";

const highRiskCodexSettingKinds = new Set(["permissions"]);

export async function routeCodexSettingsManagement({
  environment,
  maximumBodyBytes,
  path,
  principalId,
  request,
  response,
  state,
  consumeHighRisk,
}) {
  if (path === "/codex/settings" && request.method === "GET") {
    try {
      sendManagementJson(response, 200, await state.loadCodexSettings({ environment }));
    } catch {
      throw new ApiError(503, "codex_settings_unavailable", "App Server 用户设置暂不可用，请检查 App Server 状态");
    }
    return true;
  }
  if (path === "/codex/settings/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "invalid_json", "管理请求正文必须是对象");
    }
    try {
      const result = await state.previewCodexSetting(body.setting, {
        environment,
        expectedVersion: body.revision,
      });
      const payload = {
        revision: result.previousVersion,
        value: result.value,
        activation: configActivationResult(result.activation),
      };
      if (highRiskCodexSettingKinds.has(body.setting?.kind)) {
        consumeHighRisk();
        const issued = state.confirmations.issue({
          sessionId: principalId,
          operation: "codex.settings.write",
          inputFingerprint: fingerprintManagementValue(body.setting),
          resourceRevision: body.revision,
          previewFingerprint: fingerprintManagementValue(payload),
        });
        payload.confirmationRequired = true;
        payload.confirmationToken = issued.token;
        payload.confirmationExpiresAt = issued.expiresAt;
      }
      sendManagementJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagementSecurityError) throw error;
      throw codexManagementError(error);
    }
    return true;
  }
  if (path === "/codex/settings" && request.method === "PATCH") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "invalid_json", "管理请求正文必须是对象");
    }
    let result;
    try {
      if (highRiskCodexSettingKinds.has(body.setting?.kind)) {
        consumeHighRisk();
        const previewResult = await state.previewCodexSetting(body.setting, {
          environment,
          expectedVersion: body.revision,
        });
        const preview = {
          revision: previewResult.previousVersion,
          value: previewResult.value,
          activation: configActivationResult(previewResult.activation),
        };
        state.confirmations.consume(body.confirmationToken, {
          sessionId: principalId,
          operation: "codex.settings.write",
          inputFingerprint: fingerprintManagementValue(body.setting),
          resourceRevision: body.revision,
          previewFingerprint: fingerprintManagementValue(preview),
        });
      }
      state.audit.assertWritable();
      result = await state.updateCodexSetting(body.setting, {
        environment,
        expectedVersion: body.revision,
      });
    } catch (error) {
      if (error instanceof ManagementSecurityError) throw error;
      throw codexManagementError(error);
    }
    invalidateProviderManagementSummary(state.providerStateCache);
    let current = null;
    try {
      current = await state.loadCodexSettings({ environment });
    } catch (error) {
      console.error("App Server 用户设置已写入，但新修订读取失败", error);
    }
    let auditStatus = "recorded";
    try {
      state.audit.record({
        sessionId: principalId,
        source: "webui",
        operation: "codex.settings.update",
        target: String(body.setting?.kind ?? "unknown"),
        inputFingerprint: fingerprintManagementValue(body.setting),
        revision: fingerprintManagementValue(result.previousVersion),
        phase: "completed",
        resultCode: "updated",
        recovery: current === null ? "re-read" : "none",
      });
    } catch (error) {
      auditStatus = "degraded";
      console.error("App Server 用户设置已写入，但审计记录失败", error);
    }
    sendManagementJson(response, 200, {
      revision: current?.version ?? null,
      value: result.value,
      activation: configActivationResult(result.activation),
      ...(current === null ? { consistency: "unknown" } : {}),
      auditStatus,
    });
    return true;
  }
  return false;
}
