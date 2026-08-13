export interface WorkspacePermissionEntry {
  sandbox?: string;
  approval_policy?: string;
  permissions?: string;
}

export type WorkspacePermissionUpdate =
  | {
      kind: "sandbox";
      value: "read-only" | "workspace-write" | "danger-full-access" | null;
    }
  | { kind: "approval"; value: "untrusted" | "on-request" | "never" | null }
  | { kind: "permissions"; value: string | null };

export class WorkspacePermissionConflictError extends Error {}

export function applyWorkspacePermissionUpdate(
  entry: WorkspacePermissionEntry,
  update: WorkspacePermissionUpdate,
): WorkspacePermissionEntry;
