import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../../runtime/gateway-config.mjs";
import {
  UserFacingError,
} from "../conversation-core/index.js";
import type {
  WorkspaceEntitlementPort,
  WorkspaceEntitlementUpdate,
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
  permissions?: string;
}

interface ConfigToml {
  workspaces: WorkspaceToml[];
}

export class TomlWorkspaceEntitlementWriter
  implements WorkspaceEntitlementPort
{
  constructor(private readonly configPath: string) {}

  updateWorkspaceEntitlements(
    workspaceId: string,
    update: WorkspaceEntitlementUpdate,
  ): Promise<Workspace> {
    try {
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
      switch (update.kind) {
        case "sandbox":
          if (update.value === null) {
            delete entry.sandbox;
          } else {
            if (entry.permissions !== undefined) {
              throw conflictError();
            }
            entry.sandbox = update.value;
          }
          break;
        case "approval":
          if (update.value === null) {
            delete entry.approval_policy;
          } else {
            entry.approval_policy = update.value;
          }
          break;
        case "permissions":
          if (update.value === null) {
            delete entry.permissions;
          } else {
            if (entry.sandbox !== undefined) {
              throw conflictError();
            }
            entry.permissions = update.value;
          }
          break;
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
    "workspace.entitlement.conflict",
    "permissions 与 sandbox 互斥，不能同时配置；请先清除其中一项",
  );
}
