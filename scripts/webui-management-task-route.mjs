import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import {
  managementTaskResourceState,
  normalizeTaskRequestShape,
} from "./webui-management-task-resource.mjs";

export async function routeTaskManagement({
  environment,
  gatewayVersion,
  maximumBodyBytes,
  path,
  principalId,
  request,
  response,
  state,
}) {
  const taskMatch = path.match(/^\/tasks(?:\/([^/]+))?$/u);
  if (taskMatch && request.method === "GET") {
    if (taskMatch[1] === undefined) {
      sendManagementJson(response, 200, { tasks: state.tasks.list(principalId) });
    } else {
      const task = state.tasks.get(taskMatch[1], principalId);
      if (task === null) throw new ApiError(404, "task_not_found", "找不到管理任务");
      sendManagementJson(response, 200, task);
    }
    return true;
  }
  if (path === "/tasks/preview" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    let preview;
    try {
      preview = state.tasks.preview(body);
    } catch (error) {
      throw new ApiError(400, "invalid_task", error instanceof Error ? error.message : "任务输入无效");
    }
    const normalized = normalizeTaskRequestShape(body);
    const inputFingerprint = fingerprintManagementValue(normalized);
    const resource = await taskResource(
      normalized,
      environment,
      state.serviceStatusCache,
      gatewayVersion,
    );
    preview = { ...preview, resource };
    const resourceRevision = fingerprintManagementValue(resource);
    const issued = state.confirmations.issue({
      sessionId: principalId,
      operation: "management.task",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(preview),
    });
    sendManagementJson(response, 200, {
      preview,
      resourceRevision,
      confirmationToken: issued.token,
      confirmationExpiresAt: issued.expiresAt,
    });
    return true;
  }
  if (path === "/tasks" && request.method === "POST") {
    const body = await readJsonBody(request, maximumBodyBytes);
    if (!body || typeof body !== "object" || typeof body.confirmationToken !== "string") {
      throw new ApiError(400, "invalid_task", "任务写入请求必须包含 confirmationToken");
    }
    const normalized = normalizeTaskRequestShape(body);
    let preview;
    try {
      preview = state.tasks.preview(normalized);
    } catch (error) {
      throw new ApiError(400, "invalid_task", error instanceof Error ? error.message : "任务输入无效");
    }
    const inputFingerprint = fingerprintManagementValue(normalized);
    const resource = await taskResource(
      normalized,
      environment,
      state.serviceStatusCache,
      gatewayVersion,
    );
    preview = { ...preview, resource };
    const resourceRevision = fingerprintManagementValue(resource);
    state.confirmations.consume(body.confirmationToken, {
      sessionId: principalId,
      operation: "management.task",
      inputFingerprint,
      resourceRevision,
      previewFingerprint: fingerprintManagementValue(preview),
    });
    try {
      state.audit.assertWritable();
      const task = state.tasks.start(normalized, {
        owner: principalId,
        environment,
        auditMetadata: {
          sessionId: principalId,
          source: "webui",
          operation: "management.task",
          target: `${normalized.operation}:${normalized.action}:${normalized.target ?? ""}`,
          inputFingerprint,
          revision: resourceRevision,
          previewId: fingerprintManagementValue(preview),
          confirmationId: fingerprintManagementValue(body.confirmationToken),
        },
      });
      let auditStatus = "recorded";
      try {
        state.audit.record({
          sessionId: principalId,
          source: "webui",
          operation: "management.task",
          target: `${normalized.operation}:${normalized.action}:${normalized.target ?? ""}`,
          inputFingerprint,
          revision: resourceRevision,
          previewId: fingerprintManagementValue(preview),
          confirmationId: fingerprintManagementValue(body.confirmationToken),
          phase: "started",
          resultCode: "queued",
          recovery: "retry-task",
        });
      } catch (error) {
        auditStatus = "degraded";
        console.error("管理任务已启动，但启动审计记录失败", error);
      }
      sendManagementJson(response, 202, { ...task, auditStatus });
    } catch (error) {
      throw new ApiError(400, "task_start_failed", error instanceof Error ? error.message : "任务启动失败");
    }
    return true;
  }
  const cancelMatch = path.match(/^\/tasks\/([^/]+)$/u);
  if (cancelMatch && request.method === "DELETE") {
    const task = state.tasks.cancel(cancelMatch[1], principalId);
    if (task === null) throw new ApiError(404, "task_not_found", "找不到管理任务");
    sendManagementJson(response, 200, task);
    return true;
  }
  return false;
}

function taskResource(normalized, environment, serviceStatusCache, gatewayVersion) {
  return managementTaskResourceState(
    normalized,
    environment,
    serviceStatusCache,
    gatewayVersion,
    (...args) => new ApiError(...args),
  );
}
