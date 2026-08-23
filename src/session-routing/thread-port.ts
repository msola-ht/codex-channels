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
  modelProvider: string;
  preview: string;
  name: string | null;
  isPinned: boolean;
  section?: ThreadSectionSnapshot | null;
  status: ThreadStatus;
  cwd: string;
  source: ThreadSource;
  historyMode: ThreadHistoryMode;
  activeTurnId: string | null;
}

export interface ThreadSession {
  thread: ThreadSnapshot;
  model: string;
  modelProvider?: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  contextCompactionItemIds: readonly string[];
}

export interface ThreadStartOptions {
  model?: string;
  modelProvider?: string;
  /** The only non-interactive source exposed by the stable Gateway port. */
  threadSource?: "automation";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  permissions?: string;
  /** Create an in-memory thread that is omitted from durable thread listings. */
  ephemeral?: boolean;
}

export interface ThreadQueryOptions {
  fullScan?: boolean;
  archived?: boolean;
  searchTerm?: string;
  sectionId?: string;
  sortKey?: "created_at" | "updated_at" | "recency_at" | "section_position";
  sortDirection?: "asc" | "desc";
}

export interface ThreadLifecyclePort {
  listThreads(cwd: string, options?: ThreadQueryOptions): Promise<ThreadSnapshot[]>;
  readThread(threadId: string): Promise<ThreadSnapshot>;
  startThread(cwd: string, options?: ThreadStartOptions): Promise<ThreadSession>;
  resumeThread(
    threadId: string,
    cwd: string,
    options?: ThreadStartOptions,
  ): Promise<ThreadSession>;
  forkThread(
    threadId: string,
    cwd: string,
    options?: ThreadStartOptions,
  ): Promise<ThreadSession>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<ThreadSnapshot>;
  unsubscribeThread(threadId: string): Promise<void>;
}
