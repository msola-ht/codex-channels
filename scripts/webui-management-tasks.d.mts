export type ManagementTaskOperation = "service" | "metrics" | "traffic" | "update";
export interface ManagementTaskInput {
  operation: ManagementTaskOperation;
  action?: string;
  target?: string;
}
export interface ManagementTask {
  id: string;
  owner: string;
  operation: ManagementTaskOperation;
  action: string;
  target: string | null;
  state: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  error: string | null;
  errorCode: import("./webui-api.js").ManagementTask["errorCode"];
  auditStatus: "recorded" | "degraded" | null;
  result: import("./webui-api.js").ManagementTaskResult | null;
}
export class ManagementTaskInputError extends Error {}
export class WebuiManagementTaskRunner {
  constructor(options?: { now?: () => number; onEvent?: (event: {
    task: Omit<ManagementTask, "owner">;
    phase: "started" | "failed" | "cancelled" | "completed";
    resultCode: string;
    recovery: string;
    sessionId?: string;
    source?: string;
    operation?: string;
    target?: string;
    inputFingerprint?: string;
    revision?: string;
    previewId?: string;
    confirmationId?: string;
  }) => void; cancellationGraceMs?: number });
  preview(input: ManagementTaskInput): Record<string, unknown>;
  start(input: ManagementTaskInput, options?: { owner?: string; environment?: NodeJS.ProcessEnv; auditMetadata?: Record<string, unknown> | null; trafficConfirmation?: { directory: string; fingerprint: string } | null }): Omit<ManagementTask, "owner">;
  close(): Promise<void>;
  waitForExit(): Promise<void>;
  get(id: string, owner: string): Omit<ManagementTask, "owner"> | null;
  list(owner: string): Array<Omit<ManagementTask, "owner">>;
  watch(owner: string, signal: AbortSignal, receive: (type: "changed" | "heartbeat") => void): Promise<void>;
  cancel(id: string, owner: string): Omit<ManagementTask, "owner"> | null;
}
export function normalizeTaskInput(input: unknown): { operation: ManagementTaskOperation; action: string; target?: string };
