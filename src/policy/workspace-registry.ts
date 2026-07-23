import { UserFacingError } from "../conversation-core/index.js";

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
}

export class WorkspaceRegistry {
  private byId = new Map<string, Workspace>();
  private currentDefaultWorkspaceId: string;

  constructor(
    workspaces: readonly Workspace[],
    defaultWorkspaceId: string,
  ) {
    this.currentDefaultWorkspaceId = defaultWorkspaceId;
    this.replace(workspaces, defaultWorkspaceId);
  }

  get defaultWorkspaceId(): string {
    return this.currentDefaultWorkspaceId;
  }

  replace(workspaces: readonly Workspace[], defaultWorkspaceId: string): void {
    const next = new Map<string, Workspace>();
    for (const workspace of workspaces) {
      if (next.has(workspace.id)) {
        throw new Error(`Workspace ID 重复：${workspace.id}`);
      }
      next.set(workspace.id, workspace);
    }
    if (!next.has(defaultWorkspaceId)) {
      throw new Error(`默认 Workspace 不存在：${defaultWorkspaceId}`);
    }
    this.byId = next;
    this.currentDefaultWorkspaceId = defaultWorkspaceId;
  }

  list(): Workspace[] {
    return [...this.byId.values()];
  }

  get(workspaceId: string): Workspace | undefined {
    return this.byId.get(workspaceId);
  }

  require(workspaceId: string): Workspace {
    const workspace = this.get(workspaceId);
    if (!workspace) {
      throw new UserFacingError(
        "workspace.missing",
        `Workspace 不存在或未获授权：${workspaceId}`,
        { workspaceId },
      );
    }
    return workspace;
  }

  default(): Workspace {
    return this.require(this.defaultWorkspaceId);
  }

  resolve(selector: string): Workspace {
    const normalized = selector.trim();
    if (!normalized) {
      throw new UserFacingError(
        "workspace.selector.required",
        "需要提供 Workspace 序号、ID 或名称",
      );
    }
    if (/^\d+$/.test(normalized)) {
      const workspace = this.list()[Number(normalized) - 1];
      if (workspace) {
        return workspace;
      }
    }
    const matches = this.list().filter(
      (workspace) => workspace.id === normalized || workspace.name === normalized,
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    const ambiguous = matches.length > 1;
    throw new UserFacingError(
      ambiguous ? "workspace.selector.ambiguous" : "workspace.selector.not-found",
      ambiguous ? "Workspace 选择不唯一" : "找不到指定 Workspace",
    );
  }
}
