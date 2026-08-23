import {
  JsonRpcError,
  type RpcServerRequest,
  type ServerRequestHandler,
} from "../codex-client/index.js";

export interface ScheduledTaskThreadLookup {
  taskForThread(threadId: string): unknown;
  noteServerRequestRejected?(threadId: string): void;
}

/**
 * Keep unattended Threads out of the interactive approval path.  Bootstrap
 * installs this wrapper only when scheduled tasks are enabled; the wrapper
 * itself remains independent of Gateway construction and configuration.
 */
export function createScheduledTaskServerRequestHandler(
  lookup: ScheduledTaskThreadLookup,
  fallback: ServerRequestHandler,
): ServerRequestHandler {
  return async (request) => {
    const threadId = threadIdFromRequest(request);
    if (threadId === undefined || lookup.taskForThread(threadId) === undefined) {
      return fallback(request);
    }
    lookup.noteServerRequestRejected?.(threadId);
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "cancel", content: null, _meta: null };
      default:
        throw new JsonRpcError(
          -32601,
          `无人值守计划任务不支持 App Server 请求：${request.method}`,
        );
    }
  };
}

function threadIdFromRequest(request: RpcServerRequest): string | undefined {
  if (typeof request.params !== "object" || request.params === null || Array.isArray(request.params)) {
    return undefined;
  }
  const threadId = (request.params as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}
