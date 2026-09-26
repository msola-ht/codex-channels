import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readGatewayConfig, validateGatewayConfigDocument } from "../runtime/gateway-config.mjs";
import { runtimeConfig, resolveConfiguredPath } from "./runtime-config.mjs";

export const deliveryUsage = `用法：codexc delivery <status|resolve|clear-fault|check-rollback>

  status [--json]                 只读显示脱敏未决清单，不显示消息正文
  resolve <id> --acknowledge      停止 Gateway 后，将已人工核对的记录结束；不重发
  clear-fault --acknowledge       停止 Gateway 并核对权威会话后解除交付故障
  check-rollback                 停止 Gateway 后检查；存在未决记录或故障时拒绝回滚

resolve 会清理对应暂存正文。执行前必须核对 App Server/渠道结果；无法核对时保留记录。
已停止、未确认的交接不会自动重发。所有命令支持 -h 和 --help。`;

export async function runDeliveryCommand(args, environment = process.env) {
  const [command, ...rest] = args;
  if (!command || args.includes("--help") || args.includes("-h")) {
    if (command && !["status", "resolve", "clear-fault", "check-rollback", "--help", "-h"].includes(command)) throw new Error(deliveryUsage);
    console.log(deliveryUsage);
    return;
  }
  const valid = command === "status" ? (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))
    : command === "resolve" ? rest.length === 2 && /^[a-f0-9]{64}$/.test(rest[0]) && rest[1] === "--acknowledge"
    : command === "clear-fault" ? rest.length === 1 && rest[0] === "--acknowledge"
    : command === "check-rollback" && rest.length === 0;
  if (!valid) throw new Error(deliveryUsage);
  const { DeliveryJournal } = await import("../dist/surfaces/index.js");
  const { configPath } = runtimeConfig(environment);
  const config = validateGatewayConfigDocument(readGatewayConfig(configPath));
  const databasePath = resolveConfiguredPath(config.storage.database_path, dirname(configPath));
  const directory = join(dirname(databasePath), "delivery-v1");
  if (!existsSync(directory)) {
    if (command !== "status" && command !== "check-rollback") throw new Error("消息待处理日志尚未建立");
    console.log(JSON.stringify({ initialized: false, records: [] }));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(DeliveryJournal.status(directory), null, 2));
    return;
  }
  let journal;
  try { journal = new DeliveryJournal(directory, { maintenance: true }); }
  catch { throw new Error("无法独占消息日志；请先停止 Gateway，并检查日志格式、权限与完整性"); }
  try {
    if (command === "resolve") journal.resolve(rest[0]);
    else if (command === "clear-fault") journal.clearRecovery();
    else if (journal.usage().records > 0 || journal.recoveryRequired) throw new Error("存在未决消息或交付故障，拒绝回滚；请先核对并保留日志和密钥备份");
    console.log(command === "check-rollback" ? "[成功] 无未决记录或交付故障；回滚前仍须保留日志和密钥备份" : "[成功] 核对结果已记录，未重发消息");
  } finally { journal.close(); }
}
