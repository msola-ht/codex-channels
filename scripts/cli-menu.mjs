import * as clackPrompts from "@clack/prompts";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { ForwardedChildSignalError, ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

export function reportMenuError(error) {
  if (error instanceof ForwardedChildSignalError) throw error;
  if ([130, 143].includes(error?.exitCode)) throw error;
  if (!(error instanceof ReportedChildExitError)) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  }
}

export async function runCliMenu({ prompts = clackPrompts, runCommand }) {
  prompts.intro("Codex Connect");
  const options = [
    { value: "launch", label: "运行与连接", hint: "Codex TUI、WebUI 与前台服务" },
    { value: "work", label: "工作区", hint: "注册目录与选择默认项目" },
    { value: "config", label: "日常设置", hint: "会话偏好与 Gateway 配置" },
    { value: "setup", label: "接入与账户", hint: "Provider、通讯渠道与项目技能" },
    { value: "service", label: "状态与服务", hint: "状态、日志、诊断与后台服务管理" },
    { value: "data", label: "数据与维护", hint: "指标、调用记录、投递核对与清理" },
    { value: "maintenance", label: "程序维护", hint: "版本、初始化、更新与卸载" },
    { value: "cancel", label: "退出" },
  ];
  let selected = "launch";
  while (true) {
    const action = await prompts.select({ message: "主菜单", showInstructions: false, initialValue: selected, options });
    if (prompts.isCancel(action) || action === "cancel") {
      prompts.outro("已退出 Codex Connect");
      return;
    }
    if (!options.some((option) => option.value === action)) throw new Error("未知 CLI 菜单操作");
    selected = action;
    try {
      if (action === "launch") await runLaunchMenu({ prompts, runCommand });
      else if (action === "service") await runServiceMenu({ prompts, runCommand });
      else if (action === "data" || action === "maintenance") await runToolGroup(action, { prompts, runCommand });
      else await runCommand([action]);
    } catch (error) {
      reportMenuError(error);
    }
  }
}

async function runLaunchMenu({ prompts, runCommand }) {
  const options = [
    { value: "remote", label: "打开 Codex TUI", hint: "连接当前工作区的共享 App Server" },
    { value: "remote-select", label: "选择工作区与 Provider 打开 TUI", hint: "本次选择，不更改默认绑定" },
    ...(["darwin", "win32"].includes(process.platform)
      ? [{ value: "app", label: "打开 Codex Desktop", hint: "首次启用共享须确认" }] : []),
    { value: "webui", label: "启动 WebUI", hint: "前台运行，退出即停止" },
    { value: "run", label: "启动前台服务", hint: "App Server 与 Gateway" },
    { value: "back", label: "返回主菜单" },
  ];
  let selected = "remote";
  while (true) {
    const action = await prompts.select({ message: "运行与连接", showInstructions: false, initialValue: selected, options });
    if (prompts.isCancel(action) || action === "back") return;
    if (!options.some((option) => option.value === action)) throw new Error("未知运行方式");
    selected = action;
    try {
      if (action === "remote-select") await runRemoteSelection({ prompts, runCommand });
      else await runCommand([action]);
    } catch (error) {
      reportMenuError(error);
    }
  }
}

async function runRemoteSelection({ prompts, runCommand }) {
  const { locateUserConfig } = await import("./runtime-config.mjs");
  const { readGatewayConfig } = await import("../runtime/gateway-config.mjs");
  const { readWorkspaceConfig } = await import("./workspace-config.mjs");
  const { resolveAppServerRuntime } = await import("../runtime/app-server-runtime.mjs");
  const { aggregateProviderId } = await import("../runtime/aggregate-model-provider.mjs");
  const config = locateUserConfig(process.env);
  const document = readGatewayConfig(config.configPath);
  const { workspaces, defaultWorkspace } = readWorkspaceConfig(document);
  const workspace = await prompts.select({ message: "选择本次连接的工作区", showInstructions: false, initialValue: "",
    options: [
      { value: "", label: "当前目录", hint: "使用当前目录与原生 Codex 配置" },
      ...workspaces.slice().sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map(item => ({ value: item.id, label: `${item.name} · ${item.id}${item.id === defaultWorkspace.id ? "（默认）" : ""}`, hint: item.cwd })),
    ],
  });
  if (prompts.isCancel(workspace)) return;
  const runtime = resolveAppServerRuntime(document, config.dataDir, process.env);
  const { loadManagedModelProviderDefinitions } = await import("../runtime/model-provider-definitions.mjs");
  const { resolveProviderSelection } = await import("./provider-selection.mjs");
  const profileNames = new Map([
    ...loadManagedModelProviderDefinitions(process.env).map(({ id, profileName }) => [id, profileName]),
    ...runtime.customSwitchingProviders.map(({ provider, profileName }) => [provider, profileName]),
  ]);
  const providers = [...new Set(runtime.managedProviders.map(({ provider }) => provider))]
    .filter(id => id !== runtime.primaryProvider && id !== aggregateProviderId).sort();
  const providerOptions = providers.map(id => {
    const profileName = profileNames.get(id);
    if (!profileName) throw new Error(`Provider ${id} 缺少已登记的 Profile，请检查接入配置`);
    return { value: profileName, label: id };
  });
  let aggregateAvailable = runtime.managedProviders.some(({ provider }) => provider === aggregateProviderId);
  if (aggregateAvailable) {
    try { resolveProviderSelection("agg"); }
    catch (error) {
      aggregateAvailable = false;
      writeCliMessage("note", `聚合入口不可选择：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const provider = await prompts.select({ message: "选择本次连接的 Provider", showInstructions: false, initialValue: "",
    options: [
      { value: "", label: "主实例", hint: runtime.primaryProvider },
      ...providerOptions,
      ...(aggregateAvailable
        ? [{ value: "agg", label: "聚合实例", hint: "使用已配置的 API Key 切换提供商" }] : []),
    ],
  });
  if (prompts.isCancel(provider)) return;
  const providerArgs = provider === "agg" ? ["--provider", "agg"]
    : provider ? ["--profile", provider] : [];
  await runCommand(["remote", ...(workspace.trim() ? ["--workspace", workspace.trim()] : []),
    ...providerArgs]);
}

async function runToolGroup(group, { prompts, runCommand }) {
  const items = group === "data" ? [
    { value: "metrics", label: "指标查询与导出", hint: "报告、会话、请求与历史额度", args: ["metrics"] },
    { value: "credit", label: "查询 OpenAI 重置券", hint: "只查询；消费使用 codexc reset-credit use", args: ["reset-credit", "list"] },
    { value: "traffic", label: "查看请求与响应转储", args: ["traffic"] },
    { value: "delivery-status", label: "投递箱状态", hint: "先停 Gateway；会恢复 sending 并清理渲染暂存，不重发", args: ["delivery", "status"] },
    { value: "delivery-list", label: "列出未确认投递", hint: "先停 Gateway；会恢复 sending 并清理渲染暂存，不重发", args: ["delivery", "list"] },
    { value: "relay", label: "模型转发状态", args: ["relay", "status"] },
    { value: "callers", label: "模型转发调用方", args: ["relay", "callers"] },
    { value: "cleanup", label: "清理与归档", hint: "归档会话、删除转储与维护指标库", args: ["cleanup"] },
  ] : [
    { value: "version", label: "查看程序版本", args: ["version"] },
    { value: "init", label: "初始化与配置向导", hint: "创建配置或继续向导，按需接入与安装服务", args: ["init"] },
    { value: "update", label: "更新程序", hint: "更新受管源码；可能停止并恢复后台服务", args: ["update"] },
    ...(process.platform === "win32"
      ? [{ value: "security", label: "修复本机私有路径权限", hint: "Windows 定向修复", args: ["security", "repair"] }] : []),
    { value: "uninstall", label: "卸载程序", hint: "后续确认安装归属；保留用户数据", args: ["uninstall"] },
  ];
  const options = [...items, { value: "back", label: "返回主菜单" }];
  let selected = items[0].value;
  while (true) {
    const action = await prompts.select({ message: group === "data" ? "数据与维护" : "程序维护",
      showInstructions: false, initialValue: selected, options });
    if (prompts.isCancel(action) || action === "back") return;
    const item = items.find(item => item.value === action);
    if (!item) throw new Error("未知工具操作");
    selected = action;
    try {
      if (["update", "security", "uninstall"].includes(action)) {
        const accepted = await prompts.confirm({ message: `继续${item.label}？${item.hint}`, initialValue: false });
        if (prompts.isCancel(accepted) || accepted !== true) continue;
      }
      await runCommand(item.args);
    } catch (error) { reportMenuError(error); }
  }
}

export async function runServiceMenu({ prompts = clackPrompts, runCommand }) {
  const options = [
    { value: "status", label: "查看状态" },
    { value: "logs", label: "查看最近日志", hint: "最近 100 行；持续跟随用 codexc logs -f" },
    { value: "doctor", label: "安装与服务诊断", hint: "只读检查安装、配置与服务" },
    { value: "start", label: "启动服务" },
    { value: "restart", label: "重启服务" },
    { value: "stop", label: "停止服务" },
    { value: "reload", label: "重载 Gateway 配置", hint: "通知运行中的 Gateway 重读；应用结果查看日志" },
    { value: "install", label: "安装后台服务", hint: "生成服务定义并启动核心服务" },
    { value: "uninstall", label: "卸载后台服务", hint: "停止并卸载全部后台服务，保留用户数据" },
    { value: "cancel", label: "返回主菜单" },
  ];
  let selected = "status";
  while (true) {
    const action = await prompts.select({ message: "状态与服务", showInstructions: false, initialValue: selected, options });
    if (prompts.isCancel(action) || action === "cancel") return;
    if (!options.some((option) => option.value === action)) throw new Error("未知服务菜单操作");
    selected = action;
    const args = [action];
    if (["status", "start", "stop", "restart", "logs"].includes(action)) {
      const target = await prompts.select({
        message: "选择服务目标", showInstructions: false,
        options: [
          { value: "all", label: "全部后台服务", hint: "App Server、Gateway 与已安装的可选服务；启动按配置跳过已关闭的 WebUI 与未启用的 Relay" },
          { value: "gateway", label: "Gateway" },
          { value: "appserver", label: "App Server", hint: "包含受监管的 Provider 实例" },
          { value: "webui", label: "WebUI" },
          { value: "relay", label: "模型转发", hint: "管理进程；监听开关在 Config → 服务访问 → 模型转发监听" },
          { value: "back", label: "返回" },
        ],
      });
      if (prompts.isCancel(target) || target === "back") continue;
      if (!["all", "gateway", "appserver", "webui", "relay"].includes(target)) throw new Error("未知服务目标");
      args.push(target);
      if (action === "logs") args.push("--lines", "100");
    }
    if (action === "uninstall") {
      const confirmed = await prompts.confirm({ message: "确认停止并卸载全部后台服务？用户数据会保留。", initialValue: false });
      if (prompts.isCancel(confirmed) || confirmed !== true) continue;
    }
    try {
      await runCommand(action === "uninstall" ? ["uninstall", "--services"] : args);
    } catch (error) {
      reportMenuError(error);
    }
  }
}
