import {
  loadGatewaySettings,
  updateGatewaySetting,
  updateGatewayDefaultModelSetting,
} from "./config-management.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { webuiLogger } from "./webui-logger.mjs";
import { assertManagedSetting } from "./webui-management-operations.mjs";
import {
  isHighRiskManagedSetting,
  normalizeManagedSetting,
  redactManagedSettings,
} from "./webui-management-settings.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";

export async function routeGatewaySettingsManagement({
  environment,
  maximumBodyBytes,
  path,
  principalId,
  request,
  response,
  state,
  consumeHighRisk,
}) {
  if (path === "/settings" && request.method === "GET") {
    sendManagementJson(response, 200, redactManagedSettings(loadGatewaySettings(environment)));
    return true;
  }
  if (path === "/settings/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    const setting = normalizeManagedSetting(body?.setting);
    assertManagedSetting(setting);
    if (isHighRiskManagedSetting(setting)) consumeHighRisk();
    const result = await updateManagedGatewaySetting(setting, {
      environment,
      expectedRevision: body.revision,
      writeConfig: () => undefined,
      writeProxyConfig: () => undefined,
      skipBackup: true,
    });
    const payload = {
      revision: body.revision,
      value: result.value,
      activation: result.activationResult,
    };
    if (isHighRiskManagedSetting(setting)) {
      const issued = state.confirmations.issue({
        sessionId: principalId,
        operation: "gateway.settings.write",
        inputFingerprint: fingerprintManagementValue(setting),
        resourceRevision: body.revision,
        previewFingerprint: fingerprintManagementValue(payload),
      });
      payload.confirmationRequired = true;
      payload.confirmationToken = issued.token;
      payload.confirmationExpiresAt = issued.expiresAt;
    }
    sendManagementJson(response, 200, payload);
    return true;
  }
  if (path === "/settings" && request.method === "PATCH") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "invalid_json", "管理请求正文必须是对象");
    }
    const input = normalizeManagedSetting(body.setting);
    assertManagedSetting(input);
    if (isHighRiskManagedSetting(input)) {
      consumeHighRisk();
      const dryRun = await updateManagedGatewaySetting(input, {
        environment,
        expectedRevision: body.revision,
        writeConfig: () => undefined,
        writeProxyConfig: () => undefined,
        skipBackup: true,
      });
      const preview = {
        revision: body.revision,
        value: dryRun.value,
        activation: dryRun.activationResult,
      };
      state.confirmations.consume(body.confirmationToken, {
        sessionId: principalId,
        operation: "gateway.settings.write",
        inputFingerprint: fingerprintManagementValue(input),
        resourceRevision: body.revision,
        previewFingerprint: fingerprintManagementValue(preview),
      });
    }
    try {
      state.audit.assertWritable();
    } catch (error) {
      webuiLogger.error({ module: "audit", event: "settings.audit_unavailable", err: error }, "管理设置未写入，审计记录不可用");
      sendManagementJson(response, 500, {
        error: {
          code: "management_audit_unavailable",
          message: "设置未写入，审计记录不可用；请检查 Gateway 数据目录权限和磁盘空间",
        },
      });
      return true;
    }
    const result = await updateManagedGatewaySetting(input, {
      environment,
      expectedRevision: body.revision,
    });
    let current = null;
    try {
      current = loadGatewaySettings(environment);
    } catch (error) {
      webuiLogger.warn({ module: "settings", event: "settings.readback_failed", err: error }, "Gateway 设置已写入，但新修订读取失败");
    }
    let auditStatus = "recorded";
    if (input.kind === "display.scope" && current !== null) {
      const saved = current.display.scopes.find(scope => scope.id === result.value.id);
      if (JSON.stringify(saved?.override ?? {}) !== JSON.stringify(result.value.override)) current = null;
    }
    if (input.kind === "display.completion" && current !== null
      && current.display.completionOverride !== result.value.completionOverride) current = null;
    if (input.kind === "display.presentation-detail" && current !== null
      && current.display.presentationDetailOverride !== result.value.presentationDetailOverride) current = null;
    if (input.kind === "display.subagents" && current !== null
      && current.display.subagentsOverride !== result.value.subagentsOverride) current = null;
    if (input.kind === "display.streaming" && current !== null
      && current.display.streamingOverride !== result.value.streamingOverride) current = null;
    if (input.kind === "display.commentary" && current !== null
      && current.display.commentaryOverride !== result.value.commentaryOverride) current = null;
    try {
      state.audit.record({
        sessionId: principalId,
        source: "webui",
        operation: "settings.update",
        target: String(input?.kind ?? "unknown"),
        inputFingerprint: fingerprintManagementValue(input),
        revision: result.previousRevision,
        phase: "completed",
        resultCode: "updated",
        recovery: current === null ? "re-read" : "none",
      });
    } catch (error) {
      auditStatus = "degraded";
      webuiLogger.error({ module: "audit", event: "settings.audit_failed", err: error }, "管理设置已写入，但审计记录失败");
    }
    sendManagementJson(response, 200, {
      revision: current?.revision ?? null,
      value: result.value,
      activation: result.activationResult,
      auditStatus,
      consistency: current === null ? "unknown" : "confirmed",
      ...(result.generatedWebuiToken === undefined ? {} : { generatedWebuiToken: result.generatedWebuiToken }),
    });
    return true;
  }
  return false;
}

function updateManagedGatewaySetting(input, options) {
  return input.kind === "system.default-model"
    ? updateGatewayDefaultModelSetting(input, options)
    : updateGatewaySetting(input, options);
}
