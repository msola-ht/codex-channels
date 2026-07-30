import type {
  Thread,
  ThreadForkResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
} from "../codex-protocol/index.js";
import type {
  ThreadSession,
  ThreadSnapshot,
  ThreadSource,
  ThreadStatus,
} from "../session-routing/index.js";

type ThreadSessionResponse =
  | ThreadStartResponse
  | ThreadResumeResponse
  | ThreadForkResponse;

export function toThreadSnapshot(thread: Thread): ThreadSnapshot {
  requireString(thread.id, "id");
  requireString(thread.sessionId, "sessionId");
  requireString(thread.preview, "preview");
  requireString(thread.cwd, "cwd");
  if (thread.name !== null) {
    requireString(thread.name, "name");
  }
  if (typeof thread.isPinned !== "boolean") {
    throw new Error("Codex Thread 响应缺少有效 isPinned");
  }
  if (!Array.isArray(thread.turns)) {
    throw new Error("Codex Thread 响应缺少有效 turns");
  }
  const activeTurn = thread.turns.findLast((turn) => turn.status === "inProgress");
  if (activeTurn) {
    requireString(activeTurn.id, "active turn id");
  }
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    preview: thread.preview,
    name: thread.name,
    isPinned: thread.isPinned,
    status: toThreadStatus(thread.status),
    cwd: thread.cwd,
    source: toThreadSource(thread.source),
    activeTurnId: activeTurn?.id ?? null,
  };
}

export function toThreadSession(response: ThreadSessionResponse): ThreadSession {
  requireString(response.model, "model");
  if (response.reasoningEffort !== null) {
    requireString(response.reasoningEffort, "reasoningEffort");
  }
  if (response.serviceTier !== null) {
    requireString(response.serviceTier, "serviceTier");
  }
  return {
    thread: toThreadSnapshot(response.thread),
    model: response.model,
    reasoningEffort: response.reasoningEffort,
    serviceTier: response.serviceTier,
    contextCompactionItemIds: contextCompactionItemIds(response.thread),
  };
}

function contextCompactionItemIds(thread: Thread): string[] {
  const ids = new Set<string>();
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "contextCompaction") {
        continue;
      }
      requireString(item.id, "context compaction item id");
      ids.add(item.id);
    }
  }
  return [...ids];
}

function toThreadStatus(status: Thread["status"]): ThreadStatus {
  switch (status.type) {
    case "notLoaded":
    case "idle":
    case "systemError":
    case "active":
      return { type: status.type };
    default:
      throw new Error("Codex Thread 响应包含未知 status");
  }
}

function toThreadSource(source: Thread["source"]): ThreadSource {
  if (source === null || source === undefined) {
    throw new Error("Codex Thread 响应缺少有效 source");
  }
  switch (source) {
    case "cli":
    case "vscode":
    case "appServer":
      return source;
    default:
      return "other";
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Codex Thread 响应缺少有效 ${field}`);
  }
}
