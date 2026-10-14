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
    { value: "launch", label: "运行与连接", hint: "打开 Codex、WebUI 或前台服务" },
    { value: "work", label: "工作区", hint: "选择项目与管理访问权限" },
    { value: "config", label: "日常设置", hint: "会话偏好与 Gateway 配置" },
    { value: "setup", label: "接入向导", hint: "模型、通讯渠道与项目技能" },
    { value: "service", label: "后台服务", hint: "状态、启停与日志" },
    { value: "tools", label: "更多工具", hint: "初始化、诊断、指标与清理" },
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
      else if (action === "tools") await runToolsMenu({ prompts, runCommand });
      else await runCommand([action]);
    } catch (error) {
      reportMenuError(error);
    }
  }
}

async function runLaunchMenu({ prompts, runCommand }) {
  const options = [
    { value: "remote", label: "打开 Codex TUI", hint: "连接当前工作区的共享 App Server" },
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
      await runCommand([action]);
    } catch (error) {
      reportMenuError(error);
    }
  }
}

async function runToolsMenu({ prompts, runCommand }) {
  const options = [
    { value: "doctor", label: "诊断", hint: "只读检查安装、配置与服务" },
    { value: "metrics", label: "指标查询与导出", hint: "用量、会话明细与额度窗口" },
    { value: "cleanup", label: "清理与归档", hint: "归档会话与维护本地数据" },
    { value: "init", label: "初始化", hint: "首次使用：配置接入与后台服务" },
    { value: "back", label: "返回主菜单" },
  ];
  let selected = "doctor";
  while (true) {
    const action = await prompts.select({ message: "更多工具", showInstructions: false, initialValue: selected, options });
    if (prompts.isCancel(action) || action === "back") return;
    if (!options.some(option => option.value === action)) throw new Error("未知工具菜单操作");
    selected = action;
    try { await runCommand([action]); }
    catch (error) { reportMenuError(error); }
  }
}

export async function runServiceMenu({ prompts = clackPrompts, runCommand }) {
  const options = [
    { value: "status", label: "查看状态" },
    { value: "start", label: "启动服务" },
    { value: "stop", label: "停止服务" },
    { value: "restart", label: "重启服务" },
    { value: "reload", label: "重载 Gateway 配置", hint: "应用已保存的配置" },
    { value: "logs", label: "查看最近日志", hint: "最近 100 行；持续跟随用 codexc logs -f" },
    { value: "install", label: "安装后台服务", hint: "生成服务定义并启动核心服务" },
    { value: "uninstall", label: "卸载后台服务", hint: "停止并卸载全部后台服务，保留用户数据" },
    { value: "cancel", label: "返回主菜单" },
  ];
  let selected = "status";
  while (true) {
    const action = await prompts.select({ message: "后台服务", showInstructions: false, initialValue: selected, options });
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
          { value: "relay", label: "模型转发", hint: "管理进程；监听开关在 Config → 模型转发监听" },
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
