import {
  ModelBaseError, loadModelBase, prepareModelBaseUpdate, getModelBaseUpdatePreview,
  applyModelBaseUpdate, closeModelBaseExports, waitForModelBaseExportsExit,
} from "./model-base-management.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { assertManagementAuditWritable } from "./webui-management-operations.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import { webuiLogger } from "./webui-logger.mjs";

const prefix = "/models/base";
const errors = {
  invalid_input: [400, "公共底座更新参数无效"],
  invalid_catalog: [503, "公共底座目录格式不支持，请检查来源与本地快照"],
  unavailable: [503, "公共底座无法安全读取，请检查数据目录权限"],
  stale_revision: [409, "底座或预览已变化或过期，请重新获取并对比"],
  export_failed: [503, "Codex 目录导出或校验失败，请检查 CLI、配置与认证"],
  write_failed: [500, "底座保存结果未确认，请重新读取并核对备份，勿直接重试"],
  busy: [409, "公共底座更新正在进行，请稍后重试"],
};

export async function routeModelBaseManagement({ environment, maximumBodyBytes, path, principalId, request, response, state }) {
  if (path !== prefix && path !== `${prefix}/preview`) return false;
  if (new URL(request.url, "http://localhost").searchParams.size) throw apiError(new ModelBaseError("invalid_input"));
  if (path === prefix && request.method === "GET") {
    try { sendManagementJson(response, 200, await loadModelBase(environment)); }
    catch (error) { throw apiError(error); }
    return true;
  }
  if (request.method !== "POST") return false;
  const previewOnly = path === `${prefix}/preview`;
  const body = await readJsonBody(request, maximumBodyBytes);
  const allowed = previewOnly ? ["revision"] : ["revision", "candidateToken", "confirmationToken"];
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))
    || !allowed.every(key => typeof body[key] === "string")) {
    throw new ApiError(400, "base_models_invalid_input", errors.invalid_input[1]);
  }
  state.modelBaseOperations ??= new Set();
  if (state.modelBaseOperationsClosed || state.shutdownController.signal.aborted) {
    throw new ApiError(503, "management_unavailable", "管理服务正在关闭");
  }
  if (state.modelBaseOperations.size) throw new ApiError(409, "base_models_busy", errors.busy[1]);
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", abort);
  if (response.destroyed || request.aborted) controller.abort();
  const pending = { controller, promise: null };
  state.modelBaseOperations.add(pending);
  pending.promise = (async () => {
    let preview;
    try {
      controller.signal.throwIfAborted();
      preview = previewOnly
        ? await prepareModelBaseUpdate({ revision: body.revision }, environment, { signal: controller.signal })
        : await getModelBaseUpdatePreview({ revision: body.revision, candidateToken: body.candidateToken }, environment);
      controller.signal.throwIfAborted();
    } catch (error) { throw apiError(error, controller.signal); }
    const input = { revision: preview.revision, candidateToken: preview.candidateToken };
    const confirmation = {
      sessionId: principalId, operation: "models.base.update",
      inputFingerprint: fingerprintManagementValue(input), resourceRevision: preview.revision,
      previewFingerprint: fingerprintManagementValue(preview),
    };
    if (previewOnly) {
      const issued = state.confirmations.issue({ ...confirmation,
        ttlMs: Math.max(1, Math.min(5 * 60_000, preview.expiresAt - Date.now())) });
      sendManagementJson(response, 200, { preview, confirmationToken: issued.token, confirmationExpiresAt: issued.expiresAt });
      return;
    }
    state.confirmations.consume(body.confirmationToken, confirmation);
    assertManagementAuditWritable(state.audit);
    let result;
    try { result = await applyModelBaseUpdate(input, environment, { signal: controller.signal }); }
    catch (error) { throw apiError(error, controller.signal); }
    let auditStatus = "recorded";
    try {
      state.audit.record({ sessionId: principalId, source: "webui", operation: confirmation.operation,
        target: "model-base", inputFingerprint: confirmation.inputFingerprint,
        revision: confirmation.resourceRevision, previewId: confirmation.previewFingerprint,
        confirmationId: fingerprintManagementValue(body.confirmationToken), phase: "completed",
        resultCode: result.status, recovery: result.consistency === "confirmed" ? "none" : "re-read" });
    } catch {
      auditStatus = "degraded";
      webuiLogger.error({ event: "model-base.audit_failed" }, "公共底座操作已完成，但审计记录失败");
    }
    sendManagementJson(response, 200, { ...result, auditStatus });
  })();
  try { await pending.promise; }
  finally {
    response.off("close", abort);
    state.modelBaseOperations.delete(pending);
  }
  return true;
}

export async function closeModelBaseOperations(state, { waitForExit = false } = {}) {
  state.modelBaseOperationsClosed = true;
  const pending = [...(state.modelBaseOperations ?? [])];
  for (const operation of pending) operation.controller.abort();
  await Promise.allSettled(pending.map(operation => operation.promise));
  if (waitForExit) await waitForModelBaseExportsExit();
  else await closeModelBaseExports();
}

function apiError(error, signal) {
  if (signal?.aborted) return new ApiError(503, "management_unavailable", "公共底座操作已取消，请重新读取确认状态");
  const code = error instanceof ModelBaseError && Object.hasOwn(errors, error.code) ? error.code : "unavailable";
  const [status, message] = errors[code];
  const detail = error instanceof ModelBaseError && ["version-mismatch", "exit", "decode", "cancelled", "timeout", "output-limit", "spawn", "cleanup-unconfirmed", "command", "export", "preview-limit", "catalog-limit", "resolve-cli", "read-cli-baseline", "encode-snapshot", "complete-deepseek", "validate-base", "validate-deepseek", "compare"].includes(error.reason) ? error.reason : undefined;
  if (status >= 500) webuiLogger.warn({ event: "model-base.operation_failed", reason: code, detail }, message);
  return new ApiError(status, `base_models_${code}`, message);
}
