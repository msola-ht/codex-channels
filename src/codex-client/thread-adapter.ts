import type {
  Thread,
  ThreadHistoryMode,
  ThreadForkResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
} from "../codex-protocol/index.js";
import type {
  ThreadSession,
  ThreadSnapshot,
  ThreadSectionSnapshot,
  ThreadSource,
  ThreadStatus,
} from "../session-routing/index.js";

type ThreadSessionResponse =
  | ThreadStartResponse
  | ThreadResumeResponse
  | ThreadForkResponse;

export const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

export function toThreadSectionSnapshot(
  section: { id: unknown; name: unknown },
): ThreadSectionSnapshot {
  requireString(section.id, "section id");
  requireString(section.name, "section name");
  return {
    id: section.id,
    name: section.name,
    builtIn: section.id === PINNED_THREAD_SECTION_ID ? "pinned" : null,
  };
}

export function toThreadSnapshot(thread: Thread): ThreadSnapshot {
  requireString(thread.id, "id");
  requireString(thread.sessionId, "sessionId");
  requireString(thread.preview, "preview");
  requireString(thread.cwd, "cwd");
  if (thread.name !== null) {
    requireString(thread.name, "name");
  }
  if (thread.section !== null) {
    requireString(thread.section.id, "section id");
    requireString(thread.section.name, "section name");
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
    modelProvider: toThreadModelProvider(thread),
    preview: thread.preview,
    name: thread.name,
    isPinned: thread.section?.id === PINNED_THREAD_SECTION_ID,
    section: thread.section === null ? null : toThreadSectionSnapshot(thread.section),
    status: toThreadStatus(thread.status),
    cwd: thread.cwd,
    source: toThreadSource(thread.source, thread.threadSource),
    historyMode: toThreadHistoryMode(thread.historyMode),
    activeTurnId: activeTurn?.id ?? null,
    updatedAt: requireUnixSeconds(thread.updatedAt, "updatedAt"),
    recencyAt: thread.recencyAt === null
      ? null
      : requireUnixSeconds(thread.recencyAt, "recencyAt"),
  };
}

function toThreadHistoryMode(mode: Thread["historyMode"]): ThreadHistoryMode {
  if (mode === "legacy" || mode === "paginated") return mode;
  throw new Error("Codex Thread 响应包含未知 historyMode");
}

function toThreadModelProvider(thread: Thread): string {
  requireString(thread.modelProvider, "modelProvider");
  return thread.modelProvider;
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
    modelProvider: response.modelProvider,
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

function toThreadSource(
  source: Thread["source"],
  threadSource: Thread["threadSource"],
): ThreadSource {
  if (threadSource === "automation") {
    return "automation";
  }
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

function requireUnixSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Codex Thread 响应缺少有效 ${field}`);
  }
  return value;
}
