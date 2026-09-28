import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DeliveryJournal } from "../dist/delivery/index.js";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { locateUserConfig, resolveConfiguredPath } from "./runtime-config.mjs";
import { isCommandHelp } from "./cli-help.mjs";

export const deliveryCommandUsage = `用法：codexc delivery <status|list|retry|confirm>
  status                            显示未确认数量与占用
  list                              分页列出投递身份、状态与发送检查点（不输出正文）
  retry <ID> --allow-duplicate        明确重发整条未知/阻塞结果，可能重复已送达的分片
  confirm <ID> --confirmed-delivered  已自行核实送达后删除未知/阻塞结果

先用 codexc service stop gateway 停止 Gateway；不需要停止共享 App Server。
重发恢复后仍须通过当前授权检查。未确认记录不按时间或容量自动删除。`;

export async function runDeliveryCommand(args, environment = process.env) {
  if (isCommandHelp(args, [[], ["status"], ["list"], ["retry"], ["confirm"]], deliveryCommandUsage) || args.length === 0) {
    console.log(deliveryCommandUsage);
    return;
  }
  const [command, id, confirmation] = args;
  const read = (command === "status" || command === "list") && args.length === 1;
  const resolve = args.length === 3 && typeof id === "string" && id.length > 0 && id.length <= 4096
    && ((command === "retry" && confirmation === "--allow-duplicate")
      || (command === "confirm" && confirmation === "--confirmed-delivered"));
  if (!read && !resolve) throw new Error(deliveryCommandUsage);
  const { configPath, dataDir } = locateUserConfig(environment);
  const config = readGatewayConfig(configPath);
  const database = resolveConfiguredPath(config.storage?.database_path, dataDir, "data/gateway.sqlite3");
  const directory = join(dirname(database), "delivery-outbox");
  if (!existsSync(join(directory, "outbox.sqlite3"))) throw new Error("投递箱尚未创建，未修改任何投递数据");
  const journal = new DeliveryJournal(directory);
  try {
    await journal.ready;
    if (command === "status") console.log(JSON.stringify(await journal.summary(), null, 2));
    else if (command === "list") {
      let after = 0;
      while (true) {
        const page = await journal.list(after);
        for (const record of page) { console.log(JSON.stringify(record)); after = record.sequence; }
        if (page.length < 100) break;
      }
    } else {
      if (!(await journal.resolve(id, command))) throw new Error("仅能处理仍存在的 uncertain 或 blocked 记录；未修改记录");
      console.log(command === "retry" ? "已标记待重发；启动 Gateway 后复核授权，可能重复已送达分片" : "已按明确送达确认清除记录");
    }
  } finally { await journal.close(); }
}
