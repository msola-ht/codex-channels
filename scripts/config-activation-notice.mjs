import { writeCliMessage } from "../runtime/cli-presentation.mjs";

export const gatewayConfigActivationNotice =
  "运行中的 Gateway 会自动重新读取配置；需要重建连接时，"
  + "后台服务会自动重启，前台进程需重新启动；"
  + "未运行时将在下次启动生效。";

export function writeGatewayConfigActivationNotice(
  output,
  environment = process.env,
  action = "auto",
) {
  const isAuto = action === "auto";
  if (!isAuto && (typeof action !== "object" || action === null)) {
    throw new Error("配置生效提示需要结构化结果");
  }
  const message = isAuto
    ? `配置已保存。\n${gatewayConfigActivationNotice}`
    : activationNotice(action);
  writeCliMessage("note", message, {
    stdout: output,
    environment,
  });
}

function activationNotice(activation) {
  if (activation.target === "webui") {
    return "配置已保存。WebUI 配置将在重启服务后生效：codexc service restart webui；CLI 参数优先于本配置。";
  }
  if (activation.target === "all") {
    return "配置已保存。请重启 Gateway 与 App Server：codexc service restart all";
  }
  if (activation.target === "app-server") {
    return "配置已保存。请重启 App Server：codexc service restart app-server";
  }
  if (activation.target === "app-server-gateway-webui") {
    return "配置已保存。App Server、Gateway 与 WebUI 均需重启。请重启 App Server 与 WebUI："
      + "codexc service restart app-server；codexc service restart webui。"
      + "托管网关会通过配置监听自动重启；如需手动重启，执行 codexc service restart gateway。"
      + "直接运行的网关需重新执行原启动命令（如 npm run dev 或 npm start）。";
  }
  if (activation.status === "reload" && activation.target === "gateway") {
    return "配置已保存。Gateway 将热加载新配置；如需手动触发，请执行 codexc service reload。";
  }
  if (activation.status === "next-thread" && activation.target === "codex") {
    return "配置已保存。新建或重新加载的 Codex Thread 将读取该设置；当前已加载的 Thread 保持不变，无需重启服务。";
  }
  if (activation.status === "next-tui" && activation.target === "codex") {
    return "配置已保存。新启动的 Codex TUI 将读取该设置，无需重启后台服务。";
  }
  if (activation.status === "next-thread-and-tui" && activation.target === "codex") {
    return "配置已保存。会话设置由新建或重新加载的 Codex Thread 读取，TUI 设置由新启动的 TUI 读取；当前已加载的 Thread 保持不变，无需重启后台服务。";
  }
  if (activation.status === "restart" && activation.target === "gateway") {
    return "配置已保存。\n该设置需要重建 Gateway 连接；后台服务运行时会自动重启，前台进程需重新启动；"
      + "未运行时将在下次启动生效；现有 Thread 不会被修改。";
  }
  if (activation.status === "none") {
    return "当前值未变化，配置文件未写入，无需重启服务。";
  }
  if (activation.status === "reinstall-required") {
    return "配置已保存。\n该设置会改变 App Server 服务环境；运行中的服务继续使用旧值，请执行 codexc service install 重新生成并启动服务。";
  }
  if (activation.status === "failed") {
    return "配置已保存，但尚未确定生效方式；请检查配置并执行 codexc doctor。";
  }
  return `配置已保存。\n${gatewayConfigActivationNotice}`;
}
