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
  const message = action === "restart"
    ? "该设置需要重建 Gateway 连接；后台服务运行时会自动重启，前台进程需重新启动；"
      + "未运行时将在下次启动生效；现有 Thread 不会被修改。"
    : action === "reinstall"
      ? "该设置会改变 App Server 服务环境；运行中的服务继续使用旧值，请执行 codexc service install 重新生成并启动服务。"
      : gatewayConfigActivationNotice;
  writeCliMessage("note", message, {
    stdout: output,
    environment,
  });
}
