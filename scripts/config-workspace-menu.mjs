import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  applyWorkspacePermissionUpdate,
  WorkspacePermissionConflictError,
} from "../runtime/workspace-permission.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runWorkspaceSettings({
  environment,
  output,
  prompts,
  writeConfig = writeGatewayConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  if (workspaces.length === 0) {
    output.write("当前没有已配置的 Workspace。\n");
    return { action: "back" };
  }
  const workspaceEntries = workspaces.map((entry) => table(entry));
  const workspace =
    workspaceEntries.length === 1
      ? String(workspaceEntries[0].id)
      : await prompts.select({
          message: "选择要设置的 Workspace",
          showInstructions: false,
          options: workspaceEntries.map((entry) => ({
            value: String(entry.id),
            label: String(entry.name || entry.id),
            hint: String(entry.id),
          })),
        });
  if (prompts.isCancel(workspace) || workspace === undefined) {
    return { action: "back" };
  }
  const index = workspaceEntries.findIndex(
    (entry) => entry.id === workspace,
  );
  if (index < 0) {
    throw new Error(`未知 Workspace：${String(workspace)}`);
  }
  const entry = workspaceEntries[index];
  while (true) {
    const field = await prompts.select({
      message: `选择 ${entry.name ?? entry.id} 的权限项`,
      showInstructions: false,
      options: [
        {
          value: "sandbox",
          label: "沙箱",
          hint: `当前：${entry.sandbox ?? "未配置（使用全局）"}`,
        },
        {
          value: "approval_policy",
          label: "审批策略",
          hint: `当前：${entry.approval_policy ?? "未配置（使用默认）"}`,
        },
        {
          value: "permissions",
          label: "权限 Profile",
          hint: `当前：${entry.permissions ?? "未配置"}`,
        },
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(field) || field === "back") {
      return { action: "back" };
    }
    let update;
    if (field === "sandbox") {
      const selected = await prompts.select({
        message: "沙箱模式",
        showInstructions: false,
        initialValue: entry.sandbox ?? "workspace-write",
        options: [
          { value: "read-only", label: "只读", hint: "禁止写文件" },
          { value: "workspace-write", label: "工作区可写", hint: "允许修改授权 Workspace" },
          { value: "danger-full-access", label: "完全访问", hint: "不启用文件系统沙箱" },
          { value: "clear", label: "清除（使用全局）", hint: "回退 codex.sandbox" },
        ],
      });
      if (prompts.isCancel(selected)) continue;
      if (selected !== "clear" && selected !== "read-only" && selected !== "workspace-write" && selected !== "danger-full-access") {
        throw new Error(`未知沙箱模式：${String(selected)}`);
      }
      update = { kind: "sandbox", value: selected === "clear" ? null : selected };
    } else if (field === "approval_policy") {
      const selected = await prompts.select({
        message: "审批策略",
        showInstructions: false,
        initialValue: entry.approval_policy ?? "on-request",
        options: [
          { value: "untrusted", label: "不信任", hint: "更严格地要求审批" },
          { value: "on-request", label: "按需审批", hint: "需要时请求审批" },
          { value: "never", label: "免审批", hint: "不再请求审批" },
          { value: "clear", label: "清除（使用默认）", hint: "回退 on-request" },
        ],
      });
      if (prompts.isCancel(selected)) continue;
      if (selected !== "clear" && selected !== "untrusted" && selected !== "on-request" && selected !== "never") {
        throw new Error(`未知审批策略：${String(selected)}`);
      }
      update = { kind: "approval", value: selected === "clear" ? null : selected };
    } else if (field === "permissions") {
      const selected = await prompts.text({
        message: "权限 Profile（留空清除；例如 :read-only、:workspace、:danger-full-access）",
        initialValue: entry.permissions ?? "",
      });
      if (prompts.isCancel(selected)) {
        continue;
      }
      const trimmed = String(selected).trim();
      update = { kind: "permissions", value: trimmed || null };
    } else {
      throw new Error(`未知工作区权限项：${String(field)}`);
    }
    try {
      applyWorkspacePermissionUpdate(entry, update);
    } catch (error) {
      if (error instanceof WorkspacePermissionConflictError) {
        output.write(`${error.message}\n`);
        continue;
      }
      throw error;
    }
    document.workspaces = workspaces;
    writeConfig(configPath, document);
    output.write(
      `已更新 ${entry.name ?? entry.id} 的权限：${configPath}\n`
        + "权限热加载后对新建或恢复的 Thread 生效，不改变已绑定 Thread。\n",
    );
    return {
      workspaceId: String(entry.id),
      sandbox: entry.sandbox,
      approvalPolicy: entry.approval_policy,
      permissions: entry.permissions,
      configPath,
    };
  }
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
