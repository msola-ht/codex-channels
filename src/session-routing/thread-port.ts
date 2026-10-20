import type { ThreadApprovalsReviewer } from "../conversation-core/index.js";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active" };

export type ThreadSource = "cli" | "vscode" | "appServer" | "automation" | "other";
export type ThreadHistoryMode = "legacy" | "paginated";

export interface ThreadSectionSnapshot {
  id: string;
  name: string;
  builtIn: "pinned" | null;
}

export interface ThreadSnapshot {
  id: string;
  sessionId: string;
  /** Official spawned-parent relationship; forks remain independent. */
  parentThreadId?: string | null;
  modelProvider: string;
  /** Current configured model, or latest persisted value when unloaded; not execution telemetry. */
  model?: string | null;
  /** Current configured effort, or latest persisted value when unloaded; not execution telemetry. */
  reasoningEffort?: string | null;
  preview: string;
  name: string | null;
  isPinned: boolean;
  section?: ThreadSectionSnapshot | null;
  status: ThreadStatus;
  cwd: string;
  source: ThreadSource;
  historyMode: ThreadHistoryMode;
  activeTurnId: string | null;
  /** Matching live start/terminal notifications observed on the current subscription;
   * never inferred from metadata or stored history. Absent means unknown. */
  observedTerminalTurnId?: string;
  /** Unix timestamp (seconds) when the Thread was last updated by App Server. */
  updatedAt?: number;
  /** Unix timestamp (seconds) used by App Server for recency ordering. */
  recencyAt?: number | null;
}

/** A system error alone is not a terminal event. Callers must still check local
 * work, interactions, descendants and Queue. Unsubscribe invalidates evidence. */
export function isThreadExecutionSettled(thread: Pick<ThreadSnapshot, "status" | "activeTurnId" | "observedTerminalTurnId">): boolean {
  return thread.activeTurnId === null && (thread.status.type === "idle" || thread.status.type === "notLoaded"
    || (thread.status.type === "systemError" && Boolean(thread.observedTerminalTurnId)));
}

export interface ThreadSession {
  thread: ThreadSnapshot;
  model: string;
  modelProvider?: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  /** Actual Thread reviewer returned by App Server; absent or null means unknown. */
  approvalsReviewer?: ThreadApprovalsReviewer | null;
  contextCompactionItemIds: readonly string[];
  /** Actual runtime permission settings returned by App Server, not Gateway defaults. */
  effectiveSettings: {
    cwd: string;
    approvalPolicy: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access" | "external-sandbox";
    permissions: string | null;
  };
}

export interface ThreadResumeSession extends ThreadSession {
  collaborationMode: "default" | "plan";
  settingsMatch: boolean;
}

export interface ThreadDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface ThreadStartOptions {
  /** Local lifecycle guard, called after preparation immediately before the RPC write. */
  beforeSubmit?: () => void;
  model?: string;
  modelProvider?: string;
  /** The only non-interactive source exposed by the stable Gateway port. */
  threadSource?: "automation";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  approvalsReviewer?: "user" | "auto_review";
  permissions?: string;
  /** Create an in-memory thread that is omitted from durable thread listings. */
  ephemeral?: boolean;
  /** Official experimental functions shown to the model for this Thread. */
  dynamicTools?: readonly ThreadDynamicToolSpec[];
}

export interface ThreadQueryOptions {
  beforeSubmit?: () => void;
  fullScan?: boolean;
  archived?: boolean;
  searchTerm?: string;
  sectionId?: string;
  sortKey?: "created_at" | "updated_at" | "recency_at" | "section_position";
  sortDirection?: "asc" | "desc";
}

export interface ThreadLifecyclePort {
  /**
   * 当前已配置、能够独立承载 App Server 的模型 Provider 判定。
   * 未实现的部署视为不做限制，只使用主 App Server 时无需实现。
   */
  isProviderConfigured?(provider: string): boolean;
  listThreads(cwd: string, options?: ThreadQueryOptions): Promise<ThreadSnapshot[]>;
  readThread(threadId: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<ThreadSnapshot>;
  /** Authoritative loaded descendants, including ephemeral threads; uncertainty rejects. */
  hasActiveDescendants(threadId: string, signal?: AbortSignal): Promise<boolean>;
  startThread(cwd: string, options?: ThreadStartOptions): Promise<ThreadSession>;
  resumeThread(
    threadId: string,
    cwd: string,
    options?: ThreadStartOptions,
  ): Promise<ThreadResumeSession>;
  forkThread(
    threadId: string,
    cwd: string,
    options?: ThreadStartOptions,
  ): Promise<ThreadSession>;
  archiveThread(threadId: string, beforeSubmit?: () => void): Promise<void>;
  unarchiveThread(threadId: string, beforeSubmit?: () => void): Promise<ThreadSnapshot>;
  unsubscribeThread(threadId: string, beforeSubmit?: () => void): Promise<void>;
}
