import type {
  Workspace,
  WorkspaceApprovalPolicy,
  WorkspaceSandboxMode,
} from "../policy/index.js";

export type WorkspaceEntitlementUpdate =
  | { kind: "sandbox"; value: WorkspaceSandboxMode | null }
  | { kind: "approval"; value: WorkspaceApprovalPolicy | null }
  | { kind: "permissions"; value: string | null };

export interface WorkspaceEntitlementPort {
  updateWorkspaceEntitlements(
    workspaceId: string,
    update: WorkspaceEntitlementUpdate,
  ): Promise<Workspace>;
}
