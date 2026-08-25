import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { gatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { runWorkspaceSettings } from "./config-workspace-menu.mjs";
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
  codexc work list [--json]
  codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]
  codexc work remove <序号|ID|名称>`,
  list: `用法：codexc work list [--json]

  列出全部 Workspace 与当前默认项；--json 输出稳定 JSON。`,
  add: `用法：codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]

把 --cwd 指定的目录注册为 Workspace，未指定时使用当前目录；交互式新建请运行 codexc work。`,
  remove: `用法：codexc work remove <序号|ID|名称>

删除 Workspace 注册，不删除磁盘目录。`,
};

export async function runWorkspaceCommand(args, {
  cwd = process.cwd(),
  environment = process.env,
  output = process.stdout,
  outputIsTTY = process.stdout.isTTY,
  prompts = clackPrompts,
} = {}) {
  if (showRequestedHelp(args)) return;
  const [subcommand] = args;
  let addOptions;
  const json = subcommand === "list" && args.length === 2 && args[1] === "--json";
  if (subcommand === "list") {
    if (args.length !== 1 && !json) throw new Error(helpText.list);
  } else if (subcommand === "add") {
    addOptions = parseWorkspaceAddOptions(args.slice(1));
  } else if (subcommand === "remove") {
    if (args.length !== 2) throw new Error(helpText.remove);
  } else if (subcommand !== undefined) {
    throw new Error(helpText.work);
  }

  const runtime = requireUserConfig(environment);
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
      writeCliMessage("note", gatewayConfigActivationNotice);
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
    writeCliMessage("note", gatewayConfigActivationNotice);
    return;
  }
  if (outputIsTTY && subcommand !== "list") {
    await runWorkspaceMenu({
      runtime,
      eventQueuePath,
      fallbackDefaultWorkspace,
      environment,
      output,
      prompts,
    });
    return;
  }
  listWorkspaces(runtime.configPath, { json, output });
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

async function runWorkspaceMenu({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
  environment,
  output,
  prompts,
}) {
  prompts.intro("Codex Connect Workspace");
  while (true) {
    const action = await prompts.select({
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
    if (prompts.isCancel(action) || action === "cancel") {
      prompts.cancel("已取消");
      return;
    }
    if (action === "list") return listWorkspaces(runtime.configPath);
    if (action === "create") {
      await createWorkspaceInteractively({
        runtime,
        eventQueuePath,
        fallbackDefaultWorkspace,
        prompts,
      });
      return;
    }
    if (action === "remove") {
      await removeWorkspaceInteractively({
        runtime,
        eventQueuePath,
        fallbackDefaultWorkspace,
        prompts,
      });
      return;
    }
    if (action === "permissions") {
      const result = await runWorkspaceSettings({
        environment,
        output,
        prompts,
      });
      if (result?.action === "back") continue;
      return;
    }
    throw new Error(`未知 Workspace 操作：${String(action)}`);
  }
}

async function createWorkspaceInteractively({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
  prompts,
}) {
  const entered = await prompts.text({
    message: "工作区名称",
    placeholder: "例如：数据分析",
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return "名称不能为空";
      if ([...trimmed].length > 64) return "名称最长 64 个字符";
    },
  });
  if (prompts.isCancel(entered)) {
    prompts.cancel("已取消");
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
  const confirmed = await prompts.confirm({
    message: `将在 ${directory} 创建并注册（不会更改默认工作区），继续？`,
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed === false) {
    prompts.cancel("已取消");
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
  writeCliMessage("note", gatewayConfigActivationNotice);
}

async function removeWorkspaceInteractively({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
  prompts,
}) {
  const document = readGatewayConfig(runtime.configPath);
  const { workspaces } = inspectWorkspaceConfig(document);
  if (workspaces.length === 0) {
    writeCliMessage("note", "当前没有已配置的 Workspace。");
    return;
  }
  const selected = await prompts.select({
    message: "选择要删除的 Workspace",
    showInstructions: false,
    options: workspaces.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.id}`,
      hint: item.cwd,
    })),
  });
  if (prompts.isCancel(selected)) {
    prompts.cancel("已取消");
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
  writeCliMessage("note", gatewayConfigActivationNotice);
}

function listWorkspaces(configPath, {
  json = false,
  output = process.stdout,
} = {}) {
  const document = readGatewayConfig(configPath);
  const { workspaces, defaultWorkspaceId } = inspectWorkspaceConfig(document);
  if (json) {
    output.write(`${JSON.stringify({
      defaultWorkspaceId,
      workspaces: workspaces.map((item) => ({
        id: item.id,
        name: item.name,
        cwd: item.cwd,
        status: item.status,
        default: item.id === defaultWorkspaceId,
      })),
    })}\n`);
    return;
  }
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
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值`);
    result[option.slice(2)] = value;
    index += 1;
  }
  return result;
}
