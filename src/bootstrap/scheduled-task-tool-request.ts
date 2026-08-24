import type {
  ScheduledTaskToolResult,
  ScheduledTaskToolRunOutcome,
  ScheduledTaskToolTaskOutcome,
} from "../application/index.js";
import {
  JsonRpcError,
  type ServerRequestHandler,
} from "../codex-client/index.js";
import type {
  ConversationCommandOutcome,
} from "../application/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import {
  formatConversationCommandOutcome,
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
} from "../surfaces/index.js";
import { scheduledTaskToolName } from "../application/index.js";

export interface ScheduledTaskToolLookup {
  targetForThread(threadId: string): ConversationTarget | undefined;
  actorsForTarget(target: ConversationTarget): readonly string[];
  execute(
    target: ConversationTarget,
    actorId: string,
    args: unknown,
  ): Promise<ScheduledTaskToolResult>;
}

/**
 * Official dynamic tool request handler for foreground Gateway sessions.
 *
 * Scheduled-task execution Threads are rejected by
 * createScheduledTaskServerRequestHandler before this handler is reached.
 */
export function createScheduledTaskToolRequestHandler(
  lookup: ScheduledTaskToolLookup,
): ServerRequestHandler {
  return async (request) => {
    if (request.method !== "item/tool/call") {
      throw new JsonRpcError(
        -32601,
        `不支持的 App Server 请求：${request.method}`,
      );
    }
    const params = asRecord(request.params);
    const threadId = requiredString(params.threadId, "threadId");
    requiredString(params.turnId, "turnId");
    requiredString(params.callId, "callId");
    const namespace = params.namespace ?? null;
    if (namespace !== null) {
      throw new JsonRpcError(-32601, "Gateway 只注册了顶层 schedule_task 工具");
    }
    const tool = requiredString(params.tool, "tool");
    if (tool !== scheduledTaskToolName) {
      throw new JsonRpcError(-32601, `不支持的动态工具：${tool}`);
    }

    const target = lookup.targetForThread(threadId);
    if (!target) {
      return toolFailure("当前 Thread 未绑定 Gateway 会话，计划任务工具已拒绝");
    }
    const actors = lookup.actorsForTarget(target);
    if (actors.length !== 1) {
      return toolFailure(
        "当前会话存在多个或没有可识别的授权用户。请使用 /schedule 命令显式创建计划任务。",
      );
    }
    const result = await lookup.execute(target, actors[0]!, params.arguments);
    return {
      contentItems: [{ type: "inputText", text: formatToolResult(result) }],
      success: result.kind !== "error",
    };
  };
}

function formatToolResult(result: ScheduledTaskToolResult): string {
  switch (result.kind) {
    case "confirmation":
      return formatConversationScheduledConfirmation({
        kind: "scheduled-confirmation",
        preview: result.preview,
      });
    case "tasks":
      return formatConversationScheduledTasks({
        kind: "scheduled-tasks",
        result: result.result,
      });
    case "runs":
      return formatConversationScheduledRuns({
        kind: "scheduled-runs",
        result: result.result,
      });
    case "outcome":
      return formatOutcome(result.outcome);
    case "error":
      return result.message;
  }
}

function formatOutcome(
  outcome: ScheduledTaskToolTaskOutcome | ScheduledTaskToolRunOutcome,
): string {
  if ("task" in outcome) {
    const type = formatTaskOutcomeType(outcome.action);
    return formatConversationCommandOutcome({
      type,
      task: outcome.task,
    });
  }
  return formatConversationCommandOutcome({
    type: outcome.action === "run-requested"
      ? "scheduled-task.run-requested"
      : "scheduled-task.retry-requested",
    run: outcome.run,
  });
}

function formatTaskOutcomeType(
  action: ScheduledTaskToolTaskOutcome["action"],
): Extract<ConversationCommandOutcome, { task: unknown }>["type"] {
  switch (action) {
    case "created":
      return "scheduled-task.created";
    case "deleted":
      return "scheduled-task.deleted";
    case "renamed":
      return "scheduled-task.renamed";
    case "paused":
      return "scheduled-task.paused";
    case "resumed":
      return "scheduled-task.resumed";
  }
}

function toolFailure(message: string): unknown {
  return {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JsonRpcError(-32602, `${field} 缺失或无效`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonRpcError(-32602, "item/tool/call params 必须是对象");
  }
  return value as Record<string, unknown>;
}
