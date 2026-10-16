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
import type { ConversationInputEvent, ConversationTarget } from "../conversation-core/index.js";
import type { ScheduledTaskOperationContext } from "../scheduled-tasks/index.js";
import type { ThreadSnapshot } from "../session-routing/index.js";
import {
  formatConversationCommandOutcome,
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
} from "../surfaces/index.js";
import { scheduledTaskToolName } from "../application/index.js";

export interface ScheduledTaskToolLookup {
  targetForThread(threadId: string): ConversationTarget | undefined;
  foregroundThreadId(target: ConversationTarget): string | undefined;
  readThread(threadId: string, signal: AbortSignal): Promise<ThreadSnapshot>;
  actorsForTarget(target: ConversationTarget): readonly string[];
  rejectUnattended(threadId: string): Promise<boolean>;
  execute(
    target: ConversationTarget,
    actorId: string,
    args: unknown,
    operation: ScheduledTaskOperationContext,
  ): Promise<ScheduledTaskToolResult>;
  cancelConfirmation(token: string): void;
  presentConfirmation?(
    target: ConversationTarget,
    actorId: string,
    preview: Extract<ScheduledTaskToolResult, { kind: "confirmation" }>["preview"],
  ): void;
}

interface PendingToolRequest {
  requestId: string | number;
  threadId: string;
  turnId: string;
  callId: string;
  controller: AbortController;
}

export interface ScheduledTaskToolRequestHandler extends ServerRequestHandler {
  handleInput(event: ConversationInputEvent): void;
  resolved(requestId: string | number, threadId: string): void;
  cancelThreads(matches: (threadId: string) => boolean): void;
  close(): void;
}

/**
 * Official dynamic tool request handler for foreground Gateway sessions.
 *
 * The handler records and rejects owned execution Threads first, then also
 * checks official source, so resolved/retried Runs cannot turn their old
 * automation Thread into an interactive dynamic-tool entry point.
 */
export function createScheduledTaskToolRequestHandler(
  lookup: ScheduledTaskToolLookup,
): ScheduledTaskToolRequestHandler {
  const pending = new Set<PendingToolRequest>();
  let closed = false;
  const cancel = (matches: (request: PendingToolRequest) => boolean): void => {
    for (const entry of pending) {
      if (matches(entry)) entry.controller.abort(new Error("计划任务工具请求已失效"));
    }
  };
  const handler: ServerRequestHandler = async (request) => {
    if (request.method !== "item/tool/call") {
      throw new JsonRpcError(
        -32601,
        `不支持的 App Server 请求：${request.method}`,
      );
    }
    const params = asRecord(request.params);
    const threadId = requiredString(params.threadId, "threadId");
    const turnId = requiredString(params.turnId, "turnId");
    const callId = requiredString(params.callId, "callId");
    const namespace = params.namespace ?? null;
    if (namespace !== null) {
      throw new JsonRpcError(-32601, "Gateway 只注册了顶层 schedule_task 工具");
    }
    const tool = requiredString(params.tool, "tool");
    if (tool !== scheduledTaskToolName) {
      throw new JsonRpcError(-32601, `不支持的动态工具：${tool}`);
    }
    if (closed) return toolFailure("计划任务工具正在关闭，已拒绝新请求");

    const entry: PendingToolRequest = { requestId: request.id, threadId, turnId, callId, controller: new AbortController() };
    let result: ScheduledTaskToolResult | undefined;
    let delivered = false;
    // Capture the original authorization before the coordinator can yield.
    const target = lookup.targetForThread(threadId);
    const foreground = target ? lookup.foregroundThreadId(target) : undefined;
    const actors = target ? lookup.actorsForTarget(target) : [];
    const actorId = actors.length === 1 ? actors[0] : undefined;
    pending.add(entry);
    const operation: ScheduledTaskOperationContext = {
      signal: entry.controller.signal,
      assertCurrent() {
        entry.controller.signal.throwIfAborted();
        if (!target) throw new Error("计划任务工具尚未确认交互归属");
        const current = lookup.targetForThread(threadId);
        const actors = lookup.actorsForTarget(target);
        if (closed || current?.surface !== target.surface || current.accountId !== target.accountId
          || current.conversationId !== target.conversationId || lookup.foregroundThreadId(target) !== threadId
          || (actorId !== undefined && (actors.length !== 1 || actors[0] !== actorId))) {
          entry.controller.abort(new Error("计划任务工具请求的交互归属已失效"));
          entry.controller.signal.throwIfAborted();
        }
      },
    };
    try {
      // Register before the unattended coordinator's first asynchronous read.
      // The request itself is the authoritative Thread/Turn/call association.
      if (await lookup.rejectUnattended(threadId)) {
        return toolFailure("无人值守计划任务不能调用计划任务工具");
      }
      if (!target || foreground !== threadId) {
        return toolFailure("当前 Thread 不属于 Gateway 前台会话，计划任务工具已拒绝");
      }
      if (actorId === undefined) {
        return toolFailure("当前会话存在多个或没有可识别的授权用户。请使用 /schedule 命令显式创建计划任务。");
      }
      operation.assertCurrent();
      const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(5_000)]);
      const thread = await lookup.readThread(threadId, signal);
      signal.throwIfAborted();
      operation.assertCurrent();
      if (thread.id !== threadId || thread.source === "automation") {
        return toolFailure("当前 Thread 的交互归属无效，计划任务工具已拒绝");
      }
      result = await lookup.execute(target, actorId, params.arguments, operation);
      operation.assertCurrent();
      if (result.kind === "confirmation") lookup.presentConfirmation?.(target, actorId, result.preview);
      delivered = true;
      return {
        contentItems: [{ type: "inputText", text: formatToolResult(result) }],
        success: result.kind !== "error",
      };
    } catch {
      return toolFailure("当前工具请求或交互归属已失效，未确认计划操作结果；已提交的操作不会自动回滚，请通过 /schedule 查询。");
    } finally {
      if (!delivered && result?.kind === "confirmation") lookup.cancelConfirmation(result.preview.token);
      pending.delete(entry);
    }
  };
  return Object.assign(handler, {
    handleInput(event: ConversationInputEvent): void {
      if (event.type === "turn.completed") cancel((entry) => entry.threadId === event.threadId && entry.turnId === event.turnId);
      else if (event.type === "item.operation.updated" && event.operation.kind === "dynamicTool" && event.operation.status !== "running") {
        cancel((entry) => entry.threadId === event.threadId && entry.turnId === event.turnId && entry.callId === event.operation.itemId);
      }
      else if (event.type === "turn.started") cancel((entry) => entry.threadId === event.threadId && entry.turnId !== event.turnId);
      else if (event.type === "thread.reverted" || event.type === "thread.closed"
        || event.type === "thread.archived" || event.type === "thread.deleted") cancel((entry) => entry.threadId === event.threadId);
    },
    resolved(requestId: string | number, threadId: string): void {
      cancel((entry) => entry.requestId === requestId && entry.threadId === threadId);
    },
    cancelThreads(matches: (threadId: string) => boolean): void { cancel((entry) => matches(entry.threadId)); },
    close(): void { closed = true; cancel(() => true); },
  });
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
