import * as clackPrompts from "@clack/prompts";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { ForwardedChildSignalError, ReportedChildExitError } from "../runtime/process-lifecycle.mjs";

export function reportMenuError(error) {
  if (error instanceof ForwardedChildSignalError) throw error;
  if (!(error instanceof ReportedChildExitError)) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  }
}

export async function runCliMenu({ prompts = clackPrompts, runCommand }) {
  prompts.intro("Codex Connect");
  const options = [
    { value: "init", label: "初始化", hint: "创建用户目录与初始配置" },
    { value: "setup", label: "接入向导", hint: "Provider、渠道与项目技能" },
    { value: "config", label: "日常设置" },
    { value: "work", label: "工作区" },
    { value: "service", label: "后台服务" },
    { value: "metrics", label: "指标查询与导出" },
    { value: "cleanup", label: "清理与归档" },
    { value: "doctor", label: "诊断", hint: "只读检查安装、配置与服务" },
    { value: "remote", label: "打开 Codex TUI", hint: "连接当前工作区对应的共享 App Server" },
    { value: "webui", label: "启动 WebUI", hint: "前台运行，退出后结束服务" },
    { value: "start", label: "前台启动核心服务", hint: "App Server 与 Gateway" },
    { value: "cancel", label: "退出" },
  ];
  while (true) {
    const action = await prompts.select({ message: "选择操作", showInstructions: false, options });
    if (prompts.isCancel(action) || action === "cancel") return;
    if (!options.some((option) => option.value === action)) throw new Error("未知 CLI 菜单操作");
    try {
      await runCommand([action]);
    } catch (error) {
      reportMenuError(error);
    }
  }
}

export async function runServiceMenu({ prompts = clackPrompts, runCommand }) {
  prompts.intro("Codex Connect Services");
  const options = [
    { value: "status", label: "查看状态" },
    { value: "start", label: "启动服务" },
    { value: "stop", label: "停止服务" },
    { value: "restart", label: "重启服务" },
    { value: "reload", label: "重新读取 Gateway 配置" },
    { value: "logs", label: "查看最近日志", hint: "显示最近 100 行；持续跟随请使用 service logs -f" },
    { value: "install", label: "安装后台服务", hint: "生成全部服务定义，启动 App Server 与 Gateway" },
    { value: "uninstall", label: "卸载后台服务", hint: "停止并卸载全部后台服务，保留用户数据" },
    { value: "cancel", label: "返回" },
  ];
  while (true) {
    const action = await prompts.select({ message: "选择服务操作", showInstructions: false, options });
    if (prompts.isCancel(action) || action === "cancel") return;
    if (!options.some((option) => option.value === action)) throw new Error("未知服务菜单操作");
    const args = [action];
    if (["status", "start", "stop", "restart", "logs"].includes(action)) {
      const target = await prompts.select({
        message: "选择服务目标", showInstructions: false,
        options: [
          { value: "all", label: "核心服务", hint: "App Server 与 Gateway，不含 WebUI" },
          { value: "gateway", label: "Gateway" },
          { value: "app-server", label: "App Server", hint: "包含受监管的 Provider 实例" },
          { value: "webui", label: "WebUI" },
          { value: "back", label: "返回" },
        ],
      });
      if (prompts.isCancel(target) || target === "back") continue;
      if (!["all", "gateway", "app-server", "webui"].includes(target)) throw new Error("未知服务目标");
      args.push(target);
      if (action === "logs") args.push("--lines", "100");
    }
    if (action === "uninstall") {
      const confirmed = await prompts.confirm({ message: "确认停止并卸载全部后台服务？用户数据会保留。", initialValue: false });
      if (prompts.isCancel(confirmed) || confirmed !== true) continue;
    }
    try {
      await runCommand(args);
    } catch (error) {
      reportMenuError(error);
    }
  }
}
