import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { gatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { reportMenuError } from "./cli-menu.mjs";
import { runDefaultWorkspace } from "./config-system-menu.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import {
  addWorkspaceToConfig,
  chooseWorkspaceId,
  inspectWorkspaceConfig,
  removeWorkspaceFromConfig,
} from "./workspace-config.mjs";

const helpText = {
  work: `用法：codexc work

交互终端无子命令时进入菜单：列出、设置默认、注册当前或已有目录、新建、移除注册；新建目录位于
配置文件所在目录的 <id>-work（通常为 ~/.codex-connect/<id>-work），不更改默认工作区。

其他用法：
  codexc work list [--json]
  codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]
  codexc work remove <序号|ID|名称>`,
  list: `用法：codexc work list [--json]

  列出全部 Workspace 与当前默认项；--json 输出稳定 JSON。`,
  add: `用法：codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]

把 --cwd 指定的目录注册为 Workspace，未指定时使用当前目录；交互式新建请运行 codexc work。
--prune-missing 同时清理不存在或非目录的注册，不删除磁盘文件；先确认磁盘已挂载且这些项目不再使用。
无法访问的目录会阻止清理。`,
  remove: `用法：codexc work remove <序号|ID|名称>

移除 Workspace 注册，不删除磁盘目录；固定的 codex-connect 工作区不可移除。`,
};

export async function runWorkspaceCommand(args, {
  cwd = process.cwd(),
  environment = process.env,
  output = process.stdout,
  outputIsTTY = process.stdout.isTTY,
  inputIsTTY = process.stdin.isTTY,
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
    reportEventQueueCleanup(result, eventQueuePath);
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
    reportEventQueueCleanup(result, eventQueuePath);
    return;
  }
  if (inputIsTTY && outputIsTTY && subcommand !== "list") {
    await runWorkspaceMenu({
      cwd,
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
  cwd,
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
  environment,
  output,
  prompts,
}) {
  prompts.intro("工作区");
  let selected = "list";
  while (true) {
    const action = await prompts.select({
      message: "工作区操作",
      showInstructions: false,
      initialValue: selected,
      options: [
        { value: "list", label: "列出工作区", hint: "查看全部工作区与默认项" },
        { value: "default", label: "设置默认工作区", hint: "选择已注册工作区作为 Gateway 默认项" },
        { value: "register-current", label: "注册当前目录", hint: cwd },
        { value: "register-existing", label: "注册已有目录", hint: "输入目录路径，不创建或删除目录" },
        { value: "create", label: "新建工作区", hint: `在 ${runtime.dataDir}/<id>-work 下新建并注册` },
        { value: "remove", label: "移除工作区注册", hint: "从 Gateway 移除注册，保留磁盘目录" },
        { value: "cancel", label: "返回", hint: "结束工作区操作" },
      ],
    });
    if (prompts.isCancel(action)) {
      prompts.cancel("已取消工作区操作");
      return;
    }
    if (action === "cancel") {
      prompts.outro("已退出工作区菜单");
      return;
    }
    selected = action;
    try {
      if (action === "list") {
        listWorkspaces(runtime.configPath, { output });
        continue;
      }
      if (action === "default") {
        await runDefaultWorkspace({ environment, output, prompts });
        continue;
      }
      if (action === "register-current" || action === "register-existing") {
        const entered = action === "register-current" ? cwd : await prompts.text({
          message: "已有目录路径", initialValue: cwd,
          validate: (value) => String(value ?? "").trim() ? undefined : "目录不能为空",
        });
        if (prompts.isCancel(entered)) continue;
        const directory = realpathSync(resolve(cwd, String(entered).trim()));
        if (!statSync(directory).isDirectory()) throw new Error("Workspace 路径不是目录");
        const confirmed = await prompts.confirm({ message: `确认注册已有目录 ${directory}？`, initialValue: true });
        if (prompts.isCancel(confirmed) || confirmed !== true) continue;
        await runWorkspaceCommand(["add", "--cwd", directory], { cwd, environment, output, outputIsTTY: false });
        continue;
      }
      if (action === "create") {
        await createWorkspaceInteractively({
          runtime,
          eventQueuePath,
          fallbackDefaultWorkspace,
          prompts,
        });
        continue;
      }
      if (action === "remove") {
        await removeWorkspaceInteractively({
          runtime,
          eventQueuePath,
          fallbackDefaultWorkspace,
          prompts,
        });
        continue;
      }
      throw new Error(`未知 Workspace 操作：${String(action)}`);
    } catch (error) {
      reportMenuError(error);
    }
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
      if (trimmed.length > 64) return "名称过长，请缩短（最多 64 个字符，部分字符计为两位）";
      if (/[\r\n]/u.test(trimmed)) return "名称不能换行";
    },
  });
  if (prompts.isCancel(entered)) {
    prompts.cancel("已取消");
    return;
  }
  const name = String(entered).trim();
  if (!name || name.length > 64 || /[\r\n]/u.test(name)) {
    throw new Error("工作区名称不能为空、过长或包含换行（最多 64 个字符，部分字符计为两位）");
  }
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
  if (prompts.isCancel(confirmed)) {
    prompts.cancel("已取消");
    return;
  }
  if (confirmed === false) return;
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
  reportEventQueueCleanup(result, eventQueuePath);
}

async function removeWorkspaceInteractively({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
  prompts,
}) {
  const document = readGatewayConfig(runtime.configPath);
  const { workspaces } = inspectWorkspaceConfig(document);
  const removable = workspaces.filter((item) => item.id !== fallbackDefaultWorkspace.id
    && resolve(item.cwd) !== resolve(fallbackDefaultWorkspace.cwd));
  if (removable.length === 0) {
    writeCliMessage("note", "当前没有可移除的 Workspace；固定默认工作区不能移除。");
    return;
  }
  const selected = await prompts.select({
    message: "选择要移除注册的 Workspace（磁盘目录保留）",
    showInstructions: false,
    options: removable.map((item) => ({
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
    selector: { id: selected },
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
  reportEventQueueCleanup(result, eventQueuePath);
}

function reportEventQueueCleanup(result, eventQueuePath) {
  if (!result.eventQueueCleanupPending) return;
  writeCliMessage("note", "Workspace 配置已保存，但旧工作区通知队列清理未完成；请勿重复添加或移除。", { destination: "stderr" });
  writeCliMessage("remediation", `运行 codexc work list 核对配置，并检查通知队列及其目录的权限和占用：${eventQueuePath}`, { destination: "stderr" });
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
    const status = item.status === "available" ? "" : ` · ${item.detail}`;
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
