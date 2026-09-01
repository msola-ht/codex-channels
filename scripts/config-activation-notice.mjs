import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export const gatewayConfigActivationNotice =
  "运行中的 Gateway 会自动重新读取配置；需要重建连接时，"
  + "后台服务会自动重启，前台进程需重新启动；"
  + "未运行时将在下次启动生效。";

export function writeGatewayConfigActivationNotice(
  output,
  environment = process.env,
  action = "auto",
) {
  const legacy = action === "restart"
    ? configActivationResult("restart-gateway")
    : action === "reinstall" || action === "reinstall-services"
      ? configActivationResult("reinstall-services")
      : null;
  const activation = typeof action === "object" && action !== null
    ? action
    : legacy ?? (action === "auto" ? null : configActivationResult(action));
  const isAuto = action === "auto";
  const message = isAuto
    ? `配置已保存。\n${gatewayConfigActivationNotice}`
    : activationNotice(activation);
  writeCliMessage("note", message, {
    stdout: output,
    environment,
  });
}

function activationNotice(activation) {
  if (activation.target === "webui") {
    return "配置已保存。WebUI 配置将在重启服务后生效：codexc service restart webui；CLI 参数优先于本配置。";
  }
  if (activation.target === "center") {
    return "配置已保存。数据中心配置将在重启中心服务后生效：codexc service restart center；未运行时将在下次启动生效。";
  }
  if (activation.target === "gateway+webui") {
    return "配置已保存。Gateway 与 WebUI 将分别重启以应用新配置：codexc service restart gateway；codexc service restart webui；未运行的服务保持停止。";
  }
  if (activation.target === "all") {
    return "配置已保存。请重启 Gateway 与 App Server：codexc service restart all";
  }
  if (activation.target === "app-server") {
    return "配置已保存。请重启 App Server：codexc service restart app-server";
  }
  if (activation.status === "reload" && activation.target === "gateway") {
    return "配置已保存。Gateway 将热加载新配置；如需手动触发，请执行 codexc service reload。";
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
