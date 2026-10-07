import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../../runtime/gateway-config.mjs";
import { loadAutoReviewProviderPolicy } from "../../runtime/auto-review-provider-policy.mjs";
import {
  applyWorkspacePermissionUpdate,
  WorkspacePermissionConflictError,
} from "../../runtime/workspace-permission.mjs";
import {
  UserFacingError,
} from "../conversation-core/index.js";
import type {
  WorkspacePermissionPort,
  WorkspacePermissionUpdate,
} from "../application/index.js";
import type {
  Workspace,
  WorkspaceApprovalPolicy,
  WorkspaceSandboxMode,
} from "../policy/index.js";

interface WorkspaceToml {
  id: string;
  name: string;
  cwd: string;
  sandbox?: string;
  approval_policy?: string;
  approvals_reviewer?: "user" | "auto_review";
  permissions?: string;
}

interface ConfigToml {
  workspaces: WorkspaceToml[];
}

export class TomlWorkspacePermissionWriter
  implements WorkspacePermissionPort
{
  constructor(
    private readonly configPath: string,
    private readonly hasAutoReviewProvider: () => boolean = () => loadAutoReviewProviderPolicy().supportedProviders.size > 0,
  ) {}

  updateWorkspacePermissions(
    workspaceId: string,
    update: WorkspacePermissionUpdate,
  ): Promise<Workspace> {
    try {
      if (update.kind === "approvals-reviewer" && update.value === "auto_review" && !this.hasAutoReviewProvider()) {
        throw new UserFacingError("autoreview.provider-unsupported", "当前配置没有支持自动审查的 Provider，不能开启工作区默认自动审查");
      }
      const document = readGatewayConfig(
        this.configPath,
      ) as unknown as ConfigToml;
      const workspaces = document.workspaces;
      if (!Array.isArray(workspaces)) {
        throw new UserFacingError(
          "workspace.missing",
          `Workspace 不存在或未获授权：${workspaceId}`,
          { workspaceId },
        );
      }
      const entry = workspaces.find(
        (workspace) => workspace.id === workspaceId,
      );
      if (!entry) {
        throw new UserFacingError(
          "workspace.missing",
          `Workspace 不存在或未获授权：${workspaceId}`,
          { workspaceId },
        );
      }
      try {
        applyWorkspacePermissionUpdate(entry, update);
      } catch (error) {
        if (error instanceof WorkspacePermissionConflictError) {
          throw conflictError();
        }
        throw error;
      }
      writeGatewayConfig(
        this.configPath,
        document as unknown as ReturnType<typeof readGatewayConfig>,
      );
      const sandbox = entry.sandbox as WorkspaceSandboxMode | undefined;
      const approvalPolicy = entry.approval_policy as
        | WorkspaceApprovalPolicy
        | undefined;
      return Promise.resolve({
        id: entry.id,
        name: entry.name,
        cwd: entry.cwd,
        ...(sandbox === undefined ? {} : { sandbox }),
        ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
        ...(entry.approvals_reviewer === undefined
          ? {}
          : { approvalsReviewer: entry.approvals_reviewer }),
        ...(entry.permissions === undefined
          ? {}
          : { permissions: entry.permissions }),
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

function conflictError(): UserFacingError {
  return new UserFacingError(
    "workspace.permission.conflict",
    "permissions 与 sandbox 互斥，不能同时配置；请先清除其中一项",
  );
}
