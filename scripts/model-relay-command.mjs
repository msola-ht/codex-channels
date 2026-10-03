import { runRelayListenMenu } from "./model-relay-listen-menu.mjs";
import { isCommandHelp } from "./cli-help.mjs";
import { manageModelRelay } from "./model-relay-management.mjs";
export { manageModelRelay } from "./model-relay-management.mjs";

export const modelRelayUsage = `用法：codexc relay <命令>
  status                         查询进程、监听、请求队列与指标确认状态
  providers                      列出可用上游、模型和关闭思考能力
  callers                        列出调用方（不显示秘密或哈希）
  issue --caller ID --key ID --model 提供商/模型ID [--model ID ...] [--reasoning passthrough|off] [--name 名称]
  edit --caller ID [--model ID ...] [--reasoning passthrough|off] [--name 名称]
  rotate --caller ID             轮换并启用新秘密，保留身份
  delete --caller ID             删除调用方并撤销密钥；保留历史指标和转储
  disable [--caller ID]           禁用调用方；省略 caller 则禁用服务
  listen                         交互设置：关闭、仅本机、局域网或指定内网 IP
  enable                         启用服务配置（安装与启动通过 service）
所有命令支持 -h/--help；新秘密仅在成功保存后输出一次。`;

export function parseModelRelayCommand(args) {
  const [command, ...rest] = args;
  const commands = ["listen", "status", "providers", "callers", "issue", "rotate", "delete", "disable", "enable", "edit"];
  if (!commands.includes(command)) throw new Error(modelRelayUsage);
  const allowed = command === "issue" ? ["--caller", "--key", "--reasoning", "--name", "--model"]
    : command === "edit" ? ["--caller", "--reasoning", "--name", "--model"]
    : ["rotate", "delete", "disable"].includes(command) ? ["--caller"] : [];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("--")) throw new Error(modelRelayUsage);
    if (flag === "--model") (options.models ??= []).push(value);
    else {
      const key = flag.slice(2);
      if (options[key] !== undefined) throw new Error("Relay 参数不能重复");
      options[key] = value;
    }
  }
  if (command === "issue" && (!options.caller || !options.key || !options.models?.length)
    || ["rotate", "edit", "delete"].includes(command) && !options.caller
    || command === "edit" && options.reasoning === undefined && options.name === undefined && options.models === undefined
    || options.reasoning !== undefined && !["passthrough", "off"].includes(options.reasoning)) throw new Error(modelRelayUsage);
  return { command, ...options };
}

export async function runModelRelayCommand(args) {
  if (!args.length || isCommandHelp(args, [[], ...["listen", "status", "providers", "callers", "issue", "rotate", "delete", "disable", "enable", "edit"].map(command => [command])], modelRelayUsage)) { console.log(modelRelayUsage); return; }
  const input = parseModelRelayCommand(args);
  if (input.command === "listen") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("codexc relay listen 需要交互终端；请在终端运行，或用 relay enable/disable 修改启用状态");
    await runRelayListenMenu(); return;
  }
  console.log(JSON.stringify(await manageModelRelay(input), null, 2));
}
