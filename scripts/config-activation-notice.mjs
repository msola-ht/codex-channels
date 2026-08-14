import { writeCliMessage } from "../runtime/cli-presentation.mjs";

export const gatewayConfigActivationNotice =
  "运行中的 Gateway 会自动重新读取配置；需要重建连接时，"
  + "后台服务会自动重启，前台进程需重新启动；"
  + "未运行时将在下次启动生效。";

export function writeGatewayConfigActivationNotice(
  output,
  environment = process.env,
) {
  writeCliMessage("note", gatewayConfigActivationNotice, {
    stdout: output,
    environment,
  });
}
