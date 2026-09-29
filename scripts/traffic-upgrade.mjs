import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { parseGatewayConfig, validateGatewayConfigDocument, withGatewayConfigLock } from "../runtime/gateway-config.mjs";
import { removeLegacyRelayCapture } from "../runtime/model-relay-config.mjs";
import { assertPrivateConfigAccessSync, readPrivateFileSync } from "../runtime/private-file.mjs";
import { saveConfigWithBackup } from "./config-backup.mjs";
import { locateUserConfig } from "./runtime-config.mjs";

export const TRAFFIC_UPGRADE_USAGE = `用法：codexc traffic upgrade --enabled true|false --mode production|debug

显式选择 Codex 与 Relay 共用的采集状态，备份后移除旧 Relay 独立采集配置。
production 使用现有裁剪参数 3/65536；debug 使用 0/0。身份、凭据和保留天数不变。
先执行 codexc service stop gateway（前台 Gateway 也须退出），避免旧进程补回已删除字段。
不会停止、启动或重启服务。回退保留当前凭据和已有转储，不要恢复整份旧配置。
所有参数必填；支持 -h/--help。`;

export function parseTrafficUpgradeArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--enabled", "--mode"].includes(key) || Object.hasOwn(values, key)) throw new Error(TRAFFIC_UPGRADE_USAGE);
    values[key] = value;
  }
  if (!["true", "false"].includes(values["--enabled"]) || !["production", "debug"].includes(values["--mode"])) throw new Error(TRAFFIC_UPGRADE_USAGE);
  return { enabled: values["--enabled"] === "true", mode: values["--mode"] };
}

export async function upgradeTrafficCapture(input, environment = process.env) {
  if (typeof input.enabled !== "boolean" || !["production", "debug"].includes(input.mode)) throw new Error(TRAFFIC_UPGRADE_USAGE);
  const { configPath } = locateUserConfig(environment);
  if (await gatewayOwnerIsActive(configPath)) {
    throw new Error("转储配置升级前必须停止 Gateway，旧进程可能补回已移除字段：codexc service stop gateway；前台 Gateway 也须退出。停止后重新执行 traffic upgrade，再运行 codexc update。");
  }
  return withGatewayConfigLock(configPath, () => {
    assertPrivateConfigAccessSync(configPath);
    const content = readPrivateFileSync(configPath, 1024 * 1024);
    const document = parseGatewayConfig(content);
    const original = JSON.stringify(document);
    if (document.model_relay !== undefined) document.model_relay = removeLegacyRelayCapture(document.model_relay);
    // Validate unrelated fields before replacing even the selected global values.
    validateGatewayConfigDocument(document);
    document.debug = { ...document.debug, model_traffic_dump: input.enabled,
      model_traffic_input_items: input.mode === "debug" ? 0 : 3,
      model_traffic_item_max_bytes: input.mode === "debug" ? 0 : 65536 };
    validateGatewayConfigDocument(document);
    if (JSON.stringify(document) === original) return { result: "unchanged", backupPath: null };
    return { result: "upgraded", backupPath: saveConfigWithBackup(configPath, content, document, "traffic"),
      notice: "配置已保存；Codex 在重启 App Server 后生效，运行中的 Relay 在配置刷新后用于新请求。未重启任何服务。" };
  });
}
