import {
  applyWorkspacePermissionUpdate,
  WorkspacePermissionConflictError,
} from "../runtime/workspace-permission.mjs";
import { invalidSetting } from "./config-management-error.mjs";

export function projectWorkspaceSettings(document) {
  return (Array.isArray(document.workspaces) ? document.workspaces : [])
    .map((entry) => table(entry))
    .filter((entry) => stringValue(entry.id))
    .map((entry) => ({
      id: stringValue(entry.id),
      name: stringValue(entry.name) || stringValue(entry.id),
      sandbox: sandboxValue(entry.sandbox),
      approvalPolicy: approvalValue(entry.approval_policy),
      permissions: optionalString(entry.permissions),
    }));
}

export function applyWorkspaceSetting(document, input) {
  if (input.kind !== "workspace.permissions") return undefined;
  const workspaceId = requiredString(input.workspaceId, "workspaceId", "Workspace ID");
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  const entry = workspaces.find((candidate) => table(candidate).id === workspaceId);
  if (entry === undefined) {
    throw invalidSetting("workspaceId", "unknown-workspace", `找不到 Workspace：${workspaceId}`);
  }
  const update = normalizeUpdate(input.update);
  try {
    applyWorkspacePermissionUpdate(entry, update);
  } catch (error) {
    if (error instanceof WorkspacePermissionConflictError) {
      throw invalidSetting("update", "permission-conflict", error.message);
    }
    throw error;
  }
  return {
    value: projectWorkspaceSettings(document).find((workspace) => workspace.id === workspaceId),
    activation: "none",
  };
}

function normalizeUpdate(update) {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw invalidSetting("update", "invalid-input", "Workspace 权限更新必须是对象");
  }
  if (update.kind === "sandbox") {
    if (update.value !== null && !["read-only", "workspace-write", "danger-full-access"].includes(update.value)) {
      throw invalidSetting("update.value", "invalid-choice", "Workspace 沙箱模式无效");
    }
    return { kind: "sandbox", value: update.value };
  }
  if (update.kind === "approval") {
    if (update.value !== null && !["untrusted", "on-request", "never"].includes(update.value)) {
      throw invalidSetting("update.value", "invalid-choice", "Workspace 审批策略无效");
    }
    return { kind: "approval", value: update.value };
  }
  if (update.kind === "permissions") {
    const value = update.value === null ? null : optionalString(update.value);
    if (value === null && update.value !== null) {
      throw invalidSetting("update.value", "required", "Workspace 权限 Profile 不能为空");
    }
    if (value !== null && value.length > 128) {
      throw invalidSetting("update.value", "too-long", "Workspace 权限 Profile 长度不能超过 128 个字符");
    }
    return { kind: "permissions", value };
  }
  throw invalidSetting("update.kind", "invalid-choice", `Workspace 权限类型无效：${String(update.kind)}`);
}

function sandboxValue(value) {
  return ["read-only", "workspace-write", "danger-full-access"].includes(value) ? value : null;
}

function approvalValue(value) {
  return ["untrusted", "on-request", "never"].includes(value) ? value : null;
}

function requiredString(value, field, label) {
  const normalized = stringValue(value);
  if (!normalized) throw invalidSetting(field, "required", `${label}不能为空`);
  return normalized;
}

function optionalString(value) {
  const normalized = stringValue(value);
  return normalized || null;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
