import {
  OfficialModelCatalogError,
  loadOpenAiModelCatalog,
  loadOpenAiModelPrompts,
  previewOpenAiModelContext,
  applyOpenAiModelContext,
  previewOpenAiModelRefresh,
  applyOpenAiModelRefresh,
  closeOpenAiModelExports,
  waitForOpenAiModelExportsExit,
} from "./webui-official-model-catalog.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { assertManagementAuditWritable } from "./webui-management-operations.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import { webuiLogger } from "./webui-logger.mjs";

const prefix = "/models/official";
const errors = {
  cache_missing: [404, "尚无 OpenAI 模型缓存，请先通过 Codex 获取模型目录"],
  invalid_catalog: [503, "OpenAI 模型缓存格式不支持，未进行修改"],
  cache_unavailable: [503, "OpenAI 模型缓存无法读取，请检查文件权限与服务状态"],
  stale_revision: [409, "模型缓存已变化，请重新读取后操作"],
  invalid_input: [400, "上下文设置或模型选择无效"],
  write_failed: [500, "缓存写入结果未确认，请重新读取并检查备份"],
  export_failed: [503, "目录命令失败，请重新读取缓存并运行 codexc doctor 检查"],
};

export async function routeOfficialModelManagement({ environment, maximumBodyBytes, path, principalId, request, response, state }) {
  if (path === `${prefix}/prompts` && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    if (params.size !== 2 || params.getAll("model").length !== 1 || params.getAll("revision").length !== 1) {
      throw new ApiError(400, "official_models_invalid_input", "模型提示词请求参数无效");
    }
    try {
      sendManagementJson(response, 200, await loadOpenAiModelPrompts({ model: params.get("model"), revision: params.get("revision") }, environment));
    } catch (error) { throw catalogApiError(error, "read"); }
    return true;
  }
  if (path === prefix && request.method === "GET") {
    try {
      sendManagementJson(response, 200, await loadOpenAiModelCatalog(environment));
    } catch (error) {
      throw catalogApiError(error, "read");
    }
    return true;
  }
  const refresh = path === `${prefix}/refresh` || path === `${prefix}/refresh/preview`;
  const previewOnly = path === `${prefix}/preview` || path === `${prefix}/refresh/preview`;
  if (request.method !== "POST" || (!refresh && !previewOnly && path !== `${prefix}/context`)) return false;
  const body = await readJsonBody(request, maximumBodyBytes);
  const allowed = refresh ? ["revision"] : ["revision", "model", "contextWindow"];
  if (!previewOnly) allowed.push("confirmationToken");
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))
    || (!previewOnly && typeof body.confirmationToken !== "string")) {
    throw new ApiError(400, "official_models_invalid_input", "模型缓存请求字段无效");
  }
  const input = refresh ? { revision: body.revision }
    : { revision: body.revision, model: body.model, contextWindow: body.contextWindow };
  const operation = refresh ? "models.official.refresh" : "models.official.context";
  const controller = new AbortController();
  const pending = { controller, promise: null };
  state.officialModelOperations ??= new Set();
  if (state.officialModelOperationsClosed) throw new ApiError(503, "management_unavailable", "管理服务正在关闭");
  if (state.officialModelOperations.size !== 0) throw new ApiError(409, "official_models_busy", "模型缓存操作进行中，请稍后重试");
  state.officialModelOperations.add(pending);
  const abort = () => controller.abort();
  response.once("close", abort);
  pending.promise = (async () => {
    let preview;
    try {
      preview = await (refresh ? previewOpenAiModelRefresh : previewOpenAiModelContext)(input, environment, { signal: controller.signal });
    } catch (error) {
      throw catalogApiError(error, "preview", controller.signal);
    }
    if (controller.signal.aborted) throw catalogApiError(null, "preview", controller.signal);
    const confirmation = {
      sessionId: principalId,
      operation,
      inputFingerprint: fingerprintManagementValue(input),
      resourceRevision: preview.revision,
      previewFingerprint: fingerprintManagementValue(preview),
    };
    if (previewOnly) {
      const issued = state.confirmations.issue(confirmation);
      sendManagementJson(response, 200, { preview, confirmationToken: issued.token, confirmationExpiresAt: issued.expiresAt });
      return;
    }
    state.confirmations.consume(body.confirmationToken, confirmation);
    assertManagementAuditWritable(state.audit);
    let result;
    try {
      result = refresh
        ? await applyOpenAiModelRefresh(input, environment, { signal: controller.signal })
        : await applyOpenAiModelContext(input, environment, { signal: controller.signal });
    } catch (error) {
      throw catalogApiError(error, "write", controller.signal);
    }
    let auditStatus = "recorded";
    try {
      state.audit.record({
        sessionId: principalId, source: "webui", operation,
        target: refresh ? "openai-cache" : `model:${fingerprintManagementValue(input.model)}`,
        inputFingerprint: confirmation.inputFingerprint,
        revision: confirmation.resourceRevision,
        previewId: confirmation.previewFingerprint,
        confirmationId: fingerprintManagementValue(body.confirmationToken),
        phase: "completed", resultCode: "updated", recovery: result.consistency === "confirmed" ? "none" : "re-read",
      });
    } catch {
      auditStatus = "degraded";
      webuiLogger.error({ event: "official-model-catalog.audit_failed", operation }, "模型缓存已保存，但审计记录失败");
    }
    sendManagementJson(response, 200, { ...result, auditStatus });
  })();
  try {
    await pending.promise;
  } finally {
    response.off("close", abort);
    state.officialModelOperations.delete(pending);
  }
  return true;
}

export async function closeOfficialModelOperations(state, { waitForExit = false } = {}) {
  state.officialModelOperationsClosed = true;
  const pending = [...(state.officialModelOperations ?? [])];
  for (const entry of pending) entry.controller.abort();
  await Promise.allSettled(pending.map(entry => entry.promise));
  if (waitForExit) await waitForOpenAiModelExportsExit();
  else await closeOpenAiModelExports();
}

function catalogApiError(error, phase, signal) {
  if (signal?.aborted) return new ApiError(503, "management_unavailable", "模型缓存操作已取消，请重新读取确认状态");
  const reason = error instanceof OfficialModelCatalogError && Object.hasOwn(errors, error.code)
    ? error.code : phase === "write" ? "write_failed" : "cache_unavailable";
  const [status, message] = errors[reason];
  const exportReasons = ["launch", "timeout", "output-limit", "exit", "decode", "cancelled", "termination-unconfirmed"];
  const exportReason = error instanceof OfficialModelCatalogError && exportReasons.includes(error.reason) ? error.reason : undefined;
  if (status >= 500) webuiLogger.warn({ event: "official-model-catalog.operation_failed", operation: "models.official", phase, reason, exportReason }, "OpenAI 模型缓存操作失败");
  return new ApiError(status, `official_models_${reason}`, message);
}
