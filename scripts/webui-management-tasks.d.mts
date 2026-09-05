export type ManagementTaskOperation = "service" | "metrics" | "update";
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
  result: { output: string | null } | null;
}
export class WebuiManagementTaskRunner {
  constructor(options?: { now?: () => number; onEvent?: (event: {
    task: Omit<ManagementTask, "owner">;
    phase: "failed" | "cancelled" | "completed";
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
  start(input: ManagementTaskInput, options?: { owner?: string; environment?: NodeJS.ProcessEnv; auditMetadata?: Record<string, unknown> | null }): Omit<ManagementTask, "owner">;
  get(id: string, owner: string): Omit<ManagementTask, "owner"> | null;
  list(owner: string): Array<Omit<ManagementTask, "owner">>;
  cancel(id: string, owner: string): Omit<ManagementTask, "owner"> | null;
}
export function normalizeTaskInput(input: unknown): { operation: ManagementTaskOperation; action: string; target?: string };
