import type {
  Workspace,
  WorkspaceApprovalPolicy,
  WorkspaceSandboxMode,
} from "../policy/index.js";

export type WorkspacePermissionUpdate =
  | { kind: "sandbox"; value: WorkspaceSandboxMode | null }
  | { kind: "approval"; value: WorkspaceApprovalPolicy | null }
  | { kind: "permissions"; value: string | null }
  | { kind: "approvals-reviewer"; value: "user" | "auto_review" | null };

export interface WorkspacePermissionPort {
  updateWorkspacePermissions(
    workspaceId: string,
    update: WorkspacePermissionUpdate,
  ): Promise<Workspace>;
}
