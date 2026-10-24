import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { ManagementTaskInputError } from "./webui-management-tasks.mjs";
import { assertManagementAuditWritable, managementOperationError } from "./webui-management-operations.mjs";
import { openQueueStream } from "./webui-queue-events.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import {
  managementTaskResourceState,
  normalizeTaskRequestShape,
} from "./webui-management-task-resource.mjs";

export async function routeTaskManagement({
  environment,
  maximumBodyBytes,
  path,
  principalId,
  request,
  response,
  state,
}) {
  if (path === "/tasks/events" && request.method === "GET") {
    if (new URL(request.url, "http://localhost").searchParams.size > 0) {
      throw new ApiError(400, "unsupported_parameter", "任务通知不接受查询参数");
    }
    openQueueStream(state, response, (signal, send) => state.tasks.watch(principalId, signal, send));
    return true;
  }
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
      if (error instanceof ManagementTaskInputError) throw new ApiError(400, "invalid_task", error.message);
      throw managementOperationError(error, [], "task_preview_failed");
    }
    const normalized = normalizeTaskRequestShape(body);
    const inputFingerprint = fingerprintManagementValue(normalized);
    const resource = await taskResource(
      normalized,
      environment,
      state.serviceStatusCache,
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
      preview = state.tasks.preview(body);
    } catch (error) {
      if (error instanceof ManagementTaskInputError) throw new ApiError(400, "invalid_task", error.message);
      throw managementOperationError(error, [], "task_preview_failed");
    }
    const inputFingerprint = fingerprintManagementValue(normalized);
    const resource = await taskResource(
      normalized,
      environment,
      state.serviceStatusCache,
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
    assertManagementAuditWritable(state.audit);
    try {
      const task = state.tasks.start(normalized, {
        owner: principalId,
        environment,
        trafficConfirmation: normalized.operation === "traffic" ? {
          directory: resource.dumps.directory,
          fingerprint: resource.dumps.fingerprint,
        } : null,
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
      sendManagementJson(response, 202, task);
    } catch (error) {
      if (error instanceof ManagementTaskInputError) throw new ApiError(400, "task_start_failed", error.message);
      throw managementOperationError(error, [], "task_start_failed");
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

function taskResource(normalized, environment, serviceStatusCache) {
  return managementTaskResourceState(
    normalized,
    environment,
    serviceStatusCache,
    (...args) => new ApiError(...args),
  );
}
