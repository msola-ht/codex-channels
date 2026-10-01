import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";

const basePath = "/accounts/openai/reset-credits";
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export async function routeResetCredits({ configPath, maximumBodyBytes, path, principalId, request, response, state }) {
  if (![basePath, `${basePath}/preview`, `${basePath}/consume`, `${basePath}/cancel`].includes(path)) return false;
  const controller = new AbortController();
  const disconnect = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", disconnect);
  const call = async operation => {
    try { return await state.resetGatewayCredits(configPath, operation, controller.signal); }
    catch (error) {
      const allowed = ["reset_stale", "reset_busy", "reset_unavailable", "reset_unknown"];
      // 发送后的连接丢失不能被描述为未执行。
      const code = allowed.includes(error?.code) ? error.code : operation.method === "reset/consume" ? "reset_unknown" : "reset_unavailable";
      throw new ApiError(code === "reset_stale" || code === "reset_busy" ? 409 : 503, code, "重置券操作未完成，请刷新核对状态");
    }
  };
  const binding = attemptId => ({ sessionId: principalId, operation: "openai.reset-credit.consume",
    inputFingerprint: fingerprintManagementValue({ attemptId }), resourceRevision: attemptId,
    previewFingerprint: fingerprintManagementValue({ attemptId }) });
  let attemptToRelease;
  try {
    if (path === basePath && request.method === "GET") {
      sendManagementJson(response, 200, await call({ method: "reset/list" }));
      return true;
    }
    if (request.method !== "POST") throw new ApiError(405, "invalid_request", "请求方法无效");
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_request", "重置券请求无效");
    if (path === `${basePath}/preview`) {
      if (typeof body.creditId !== "string" || !body.creditId || body.creditId.length > 256 || /[\0\r\n]/u.test(body.creditId)
        || Object.keys(body).some(key => key !== "creditId")) throw new ApiError(400, "invalid_request", "重置券选择无效");
      const preview = await call({ method: "reset/preview", creditId: body.creditId });
      if (!idPattern.test(preview?.attemptId)) throw new ApiError(502, "reset_unavailable", "重置券预览无效");
      attemptToRelease = preview.attemptId;
      const issued = state.confirmations.issue(binding(preview.attemptId));
      sendManagementJson(response, 200, { preview, confirmationToken: issued.token, confirmationExpiresAt: issued.expiresAt });
      attemptToRelease = undefined;
      return true;
    }
    if (![`${basePath}/consume`, `${basePath}/cancel`].includes(path) || typeof body.attemptId !== "string" || !idPattern.test(body.attemptId)
      || typeof body.confirmationToken !== "string" || Object.keys(body).some(key => !["attemptId", "confirmationToken"].includes(key))) {
      throw new ApiError(400, "invalid_request", "重置券确认无效");
    }
    state.confirmations.consume(body.confirmationToken, binding(body.attemptId));
    if (path === `${basePath}/cancel`) {
      sendManagementJson(response, 200, await call({ method: "reset/cancel", attemptId: body.attemptId }));
      return true;
    }
    attemptToRelease = body.attemptId;
    const audit = { sessionId: principalId, source: "webui", operation: "openai.reset-credit.consume",
      target: fingerprintManagementValue(body.attemptId), inputFingerprint: fingerprintManagementValue({ attemptId: body.attemptId }), recovery: "none" };
    try {
      state.audit.assertWritable();
      state.audit.record({ ...audit, phase: "requested", resultCode: "pending" });
    } catch {
      throw new ApiError(500, "management_audit_unavailable", "管理审计不可用，未发起重置券消费");
    }
    let result;
    try { result = await call({ method: "reset/consume", attemptId: body.attemptId }); }
    catch (error) {
      // 保留消费的不确定结果，完成审计失败不能把它覆盖为普通服务错误。
      try { state.audit.record({ ...audit, phase: "finished", resultCode: error.code }); } catch { /* 已记录 requested，仍需核对官方状态。 */ }
      throw error;
    }
    attemptToRelease = undefined;
    let auditRecorded = true;
    try { state.audit.record({ ...audit, phase: "finished", resultCode: result.outcome }); }
    catch { auditRecorded = false; }
    sendManagementJson(response, 200, { ...result, auditRecorded });
    return true;
  } finally {
    response.removeListener("close", disconnect);
    if (attemptToRelease !== undefined) {
      try {
        await state.resetGatewayCredits(configPath, { method: "reset/cancel", attemptId: attemptToRelease }, globalThis.AbortSignal.timeout(2_000));
      } catch { /* 原操作错误仍返回给调用者；未确认清理的预览由有效期兜底。 */ }
    }
  }
}
