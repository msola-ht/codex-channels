export class WorkspacePermissionConflictError extends Error {
  constructor() {
    super("permissions 与 sandbox 互斥，不能同时配置；请先清除其中一项");
    this.name = "WorkspacePermissionConflictError";
  }
}

export function applyWorkspacePermissionUpdate(entry, update) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Workspace 配置必须是对象");
  }
  switch (update.kind) {
    case "sandbox":
      if (update.value === null) {
        delete entry.sandbox;
      } else {
        if (entry.permissions !== undefined) throw new WorkspacePermissionConflictError();
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
        if (entry.sandbox !== undefined) throw new WorkspacePermissionConflictError();
        entry.permissions = update.value;
      }
      break;
    default:
      throw new Error(`未知 Workspace 权限更新：${String(update.kind)}`);
  }
  return entry;
}
