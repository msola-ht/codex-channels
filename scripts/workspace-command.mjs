import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  applyWorkspacePermissionUpdate,
  WorkspacePermissionConflictError,
} from "../runtime/workspace-permission.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import {
  addWorkspaceToConfig,
  chooseWorkspaceId,
  inspectWorkspaceConfig,
  removeWorkspaceFromConfig,
} from "./workspace-config.mjs";

const helpText = {
  work: `用法：codexc work

无子命令时进入交互菜单：列出、新增、删除、权限；新增创建在
~/.codex-connect/<id>-work，不更改默认工作区。

其他用法：
  codexc work list
  codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]
  codexc work remove <序号|ID|名称>`,
  list: `用法：codexc work list

列出全部 Workspace 与当前默认项。`,
  add: `用法：codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]

把当前目录注册为 Workspace；交互式新建请运行 codexc work。`,
  remove: `用法：codexc work remove <序号|ID|名称>

删除 Workspace 注册，不删除磁盘目录。`,
};

export async function runWorkspaceCommand(args, {
  cwd = process.cwd(),
  outputIsTTY = process.stdout.isTTY,
} = {}) {
  if (showRequestedHelp(args)) return;
  const [subcommand] = args;
  let addOptions;
  if (subcommand === "list") {
    if (args.length !== 1) throw new Error(helpText.list);
  } else if (subcommand === "add") {
    addOptions = parseWorkspaceAddOptions(args.slice(1));
  } else if (subcommand === "remove") {
    if (args.length !== 2) throw new Error(helpText.remove);
  } else if (subcommand !== undefined) {
    throw new Error(helpText.work);
  }

  const runtime = requireUserConfig();
  const eventQueuePath = configEventQueuePath(runtime.dataDir);
  const fallbackDefaultWorkspace = {
    cwd: join(runtime.dataDir, "workspace"),
    id: "codex-connect",
    name: ".codex-connect/workspace",
  };
  if (subcommand === "add") {
    const options = addOptions;
    const result = addWorkspaceToConfig({
      configPath: runtime.configPath,
      cwd: options.cwd ?? cwd,
      ...(options.id ? { id: options.id } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.pruneMissing ? { pruneMissing: true } : {}),
      fallbackDefaultWorkspace,
      eventQueuePath,
    });
    writeCliMessage(result.added ? "success" : "note", result.added ? "Workspace 已添加。" : "Workspace 已存在。");
    console.log(`${result.workspace.name} (${result.workspace.id})`);
    console.log(result.workspace.cwd);
    for (const removed of result.removedWorkspaces) {
      writeCliMessage("success", `已清理失效 Workspace：${removed.name} (${removed.id})`);
      console.log(removed.cwd);
    }
    if (result.defaultChanged) {
      writeCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
    }
    if (result.added || result.removedWorkspaces.length > 0 || result.defaultChanged) {
      writeCliMessage("note", "运行中的 Gateway 会自动热加载配置，必要时重启。");
    }
    return;
  }
  if (subcommand === "remove") {
    const result = removeWorkspaceFromConfig({
      configPath: runtime.configPath,
      selector: args[1],
      fallbackDefaultWorkspace,
      eventQueuePath,
    });
    writeCliMessage("success", `Workspace 注册已删除：${result.removedWorkspace.name} (${result.removedWorkspace.id})`);
    console.log(result.removedWorkspace.cwd);
    writeCliMessage("note", "磁盘目录未删除。");
    if (result.defaultChanged) {
      writeCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
    }
    writeCliMessage("note", "运行中的 Gateway 会自动重新加载配置，必要时重启。");
    return;
  }
  if (outputIsTTY && subcommand !== "list") {
    await runWorkspaceMenu({ runtime, eventQueuePath, fallbackDefaultWorkspace });
    return;
  }
  listWorkspaces(runtime.configPath);
}

function showRequestedHelp(args) {
  if (args.length === 1 && isHelpArgument(args[0])) {
    console.log(helpText.work);
    return true;
  }
  if (args.length === 2 && isHelpArgument(args[1])) {
    const text = helpText[args[0]];
    if (text !== undefined) {
      console.log(text);
      return true;
    }
  }
  return false;
}

function isHelpArgument(value) {
  return value === "-h" || value === "--help";
}

async function runWorkspaceMenu({ runtime, eventQueuePath, fallbackDefaultWorkspace }) {
  clackPrompts.intro("Codex Connect Workspace");
  const action = await clackPrompts.select({
    message: "选择操作",
    showInstructions: false,
    options: [
      { value: "list", label: "列出工作区", hint: "查看全部 Workspace 与默认项" },
      { value: "create", label: "新增工作区", hint: "在 ~/.codex-connect/<id>-work 下新建并注册" },
      { value: "remove", label: "删除工作区", hint: "删除注册，不删除目录" },
      { value: "permissions", label: "工作区权限", hint: "沙箱、审批策略、权限 Profile" },
      { value: "cancel", label: "取消" },
    ],
  });
  if (clackPrompts.isCancel(action) || action === "cancel") {
    clackPrompts.cancel("已取消");
    return;
  }
  if (action === "list") return listWorkspaces(runtime.configPath);
  if (action === "create") {
    await createWorkspaceInteractively({ runtime, eventQueuePath, fallbackDefaultWorkspace });
    return;
  }
  if (action === "remove") {
    await removeWorkspaceInteractively({ runtime, eventQueuePath, fallbackDefaultWorkspace });
    return;
  }
  if (action === "permissions") {
    await runWorkspacePermissionsMenu(runtime);
    return;
  }
  throw new Error(`未知 Workspace 操作：${String(action)}`);
}

async function createWorkspaceInteractively({ runtime, eventQueuePath, fallbackDefaultWorkspace }) {
  const entered = await clackPrompts.text({
    message: "工作区名称",
    placeholder: "例如：数据分析",
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return "名称不能为空";
      if ([...trimmed].length > 64) return "名称最长 64 个字符";
    },
  });
  if (clackPrompts.isCancel(entered)) {
    clackPrompts.cancel("已取消");
    return;
  }
  const name = String(entered).trim();
  const unavailableIds = inspectWorkspaceConfig(
    readGatewayConfig(runtime.configPath),
  ).workspaces.map((workspace) => workspace.id);
  let id;
  let directory;
  do {
    id = chooseWorkspaceId(name, unavailableIds);
    directory = join(runtime.dataDir, `${id}-work`);
    unavailableIds.push(id);
  } while (existsSync(directory));
  const confirmed = await clackPrompts.confirm({
    message: `将在 ${directory} 创建并注册（不会更改默认工作区），继续？`,
    initialValue: true,
  });
  if (clackPrompts.isCancel(confirmed) || confirmed === false) {
    clackPrompts.cancel("已取消");
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = addWorkspaceToConfig({
    configPath: runtime.configPath,
    cwd: directory,
    id,
    name,
    fallbackDefaultWorkspace,
    eventQueuePath,
  });
  writeCliMessage("success", "Workspace 已新增。");
  console.log(`${result.workspace.name} (${result.workspace.id})`);
  console.log(result.workspace.cwd);
  if (result.defaultChanged) {
    writeCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
  }
  writeCliMessage("note", "运行中的 Gateway 会自动热加载配置，必要时重启。");
}

async function removeWorkspaceInteractively({ runtime, eventQueuePath, fallbackDefaultWorkspace }) {
  const document = readGatewayConfig(runtime.configPath);
  const { workspaces } = inspectWorkspaceConfig(document);
  if (workspaces.length === 0) {
    writeCliMessage("note", "当前没有已配置的 Workspace。");
    return;
  }
  const selected = await clackPrompts.select({
    message: "选择要删除的 Workspace",
    showInstructions: false,
    options: workspaces.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.id}`,
      hint: item.cwd,
    })),
  });
  if (clackPrompts.isCancel(selected)) {
    clackPrompts.cancel("已取消");
    return;
  }
  const result = removeWorkspaceFromConfig({
    configPath: runtime.configPath,
    selector: selected,
    fallbackDefaultWorkspace,
    eventQueuePath,
  });
  writeCliMessage("success", `Workspace 注册已删除：${result.removedWorkspace.name} (${result.removedWorkspace.id})`);
  console.log(result.removedWorkspace.cwd);
  writeCliMessage("note", "磁盘目录未删除。");
  if (result.defaultChanged) {
    writeCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
  }
  writeCliMessage("note", "运行中的 Gateway 会自动重新加载配置，必要时重启。");
}

async function runWorkspacePermissionsMenu(runtime) {
  const document = readGatewayConfig(runtime.configPath);
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  if (workspaces.length === 0) {
    writeCliMessage("note", "当前没有已配置的 Workspace。");
    return;
  }
  const entries = workspaces.map((workspace) => table(workspace));
  const selectedId = entries.length === 1
    ? String(entries[0].id)
    : await clackPrompts.select({
        message: "选择要设置的 Workspace",
        showInstructions: false,
        options: entries.map((workspace) => ({
          value: String(workspace.id),
          label: String(workspace.name || workspace.id),
          hint: String(workspace.cwd),
        })),
      });
  if (clackPrompts.isCancel(selectedId)) {
    clackPrompts.cancel("已取消");
    return;
  }
  const entry = entries.find((workspace) => workspace.id === selectedId);
  if (!entry) throw new Error(`未知 Workspace：${String(selectedId)}`);
  const field = await clackPrompts.select({
    message: `选择 ${entry.name ?? entry.id} 的权限项`,
    showInstructions: false,
    options: [
      { value: "sandbox", label: "沙箱", hint: `当前：${entry.sandbox ?? "未配置（使用全局）"}` },
      { value: "approval_policy", label: "审批策略", hint: `当前：${entry.approval_policy ?? "未配置（使用默认）"}` },
      { value: "permissions", label: "权限 Profile", hint: `当前：${entry.permissions ?? "未配置"}` },
      { value: "cancel", label: "取消" },
    ],
  });
  if (clackPrompts.isCancel(field) || field === "cancel") {
    clackPrompts.cancel("已取消");
    return;
  }
  let update;
  if (field === "sandbox") {
    const selected = await clackPrompts.select({
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
    if (clackPrompts.isCancel(selected)) {
      clackPrompts.cancel("已取消");
      return;
    }
    if (!["clear", "read-only", "workspace-write", "danger-full-access"].includes(selected)) {
      throw new Error(`未知沙箱模式：${String(selected)}`);
    }
    update = { kind: "sandbox", value: selected === "clear" ? null : selected };
  } else if (field === "approval_policy") {
    const selected = await clackPrompts.select({
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
    if (clackPrompts.isCancel(selected)) {
      clackPrompts.cancel("已取消");
      return;
    }
    if (!["clear", "untrusted", "on-request", "never"].includes(selected)) {
      throw new Error(`未知审批策略：${String(selected)}`);
    }
    update = { kind: "approval", value: selected === "clear" ? null : selected };
  } else if (field === "permissions") {
    const entered = await clackPrompts.text({
      message: "权限 Profile（留空清除；例如 :read-only、:workspace、:danger-full-access）",
      initialValue: entry.permissions ?? "",
    });
    if (clackPrompts.isCancel(entered)) {
      clackPrompts.cancel("已取消");
      return;
    }
    const trimmed = String(entered).trim();
    update = { kind: "permissions", value: trimmed || null };
  } else {
    throw new Error(`未知工作区权限项：${String(field)}`);
  }
  try {
    applyWorkspacePermissionUpdate(entry, update);
  } catch (error) {
    if (error instanceof WorkspacePermissionConflictError) {
      writeCliMessage("failure", error.message);
      return;
    }
    throw error;
  }
  writeGatewayConfig(runtime.configPath, document);
  writeCliMessage("success", "已更新工作区权限。");
  console.log(
    `沙箱：${entry.sandbox ?? "未配置"} · 审批：${entry.approval_policy ?? "未配置"} · 权限 Profile：${entry.permissions ?? "未配置"}`,
  );
  writeCliMessage("note", "运行中的 Gateway 会自动热加载，对新建或恢复的 Thread 生效。");
}

function listWorkspaces(configPath) {
  const document = readGatewayConfig(configPath);
  const { workspaces, defaultWorkspaceId } = inspectWorkspaceConfig(document);
  console.log(`Workspace（${workspaces.length}）：`);
  workspaces.forEach((item, index) => {
    const status = item.status === "missing"
      ? " · 目录不存在"
      : item.status === "inaccessible"
        ? " · 目录无法访问"
        : "";
    console.log(`${index + 1}. ${item.name} · ${item.id}${item.id === defaultWorkspaceId ? " ← 默认" : ""}${status}`);
    console.log(`   ${item.cwd}`);
  });
}

function parseWorkspaceAddOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--prune-missing") {
      result.pruneMissing = true;
      continue;
    }
    if (!new Set(["--cwd", "--id", "--name"]).has(option)) {
      throw new Error(`未知参数：${option}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${option} 缺少值`);
    result[option.slice(2)] = value;
    index += 1;
  }
  return result;
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
