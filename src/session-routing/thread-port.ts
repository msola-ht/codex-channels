export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active" };

export type ThreadSource = "cli" | "vscode" | "appServer" | "other";

export interface ThreadSnapshot {
  id: string;
  sessionId: string;
  preview: string;
  name: string | null;
  status: ThreadStatus;
  cwd: string;
  source: ThreadSource;
  activeTurnId: string | null;
}

export interface ThreadSession {
  thread: ThreadSnapshot;
  model: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  contextCompactionItemIds: readonly string[];
}

export interface ThreadQueryOptions {
  fullScan?: boolean;
  archived?: boolean;
  searchTerm?: string;
}

export interface ThreadLifecyclePort {
  listThreads(cwd: string, options?: ThreadQueryOptions): Promise<ThreadSnapshot[]>;
  startThread(cwd: string): Promise<ThreadSession>;
  resumeThread(threadId: string, cwd: string): Promise<ThreadSession>;
  forkThread(threadId: string, cwd: string): Promise<ThreadSession>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<ThreadSnapshot>;
  unsubscribeThread(threadId: string): Promise<void>;
}
