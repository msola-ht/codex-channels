export interface Workspace {
  id: string;
  name: string;
  cwd: string;
}

export class WorkspaceRegistry {
  private readonly byId = new Map<string, Workspace>();

  constructor(
    workspaces: readonly Workspace[],
    readonly defaultWorkspaceId: string,
  ) {
    for (const workspace of workspaces) {
      if (this.byId.has(workspace.id)) {
        throw new Error(`Workspace ID 重复：${workspace.id}`);
      }
      this.byId.set(workspace.id, workspace);
    }
    if (!this.byId.has(defaultWorkspaceId)) {
      throw new Error(`默认 Workspace 不存在：${defaultWorkspaceId}`);
    }
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
      throw new Error(`Workspace 不存在或未获授权：${workspaceId}`);
    }
    return workspace;
  }

  default(): Workspace {
    return this.require(this.defaultWorkspaceId);
  }

  resolve(selector: string): Workspace {
    const normalized = selector.trim();
    if (!normalized) {
      throw new Error("用法：/workspace <序号、ID 或名称>");
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
    throw new Error(matches.length > 1 ? "Workspace 选择不唯一" : "找不到指定 Workspace");
  }
}
