import { isCommandHelp } from "./cli-help.mjs";
import { manageModelRelay } from "./model-relay-management.mjs";
export { manageModelRelay } from "./model-relay-management.mjs";

export const modelRelayUsage = `用法：codexc relay <命令>
  status                         查询进程、监听、请求队列与指标确认状态
  upgrade-limits                 显式备份并移除账户/Key 限流字段，不重启服务
  providers                      列出可用上游、模型和关闭思考能力
  callers                        列出调用方（不显示秘密或哈希）
  issue --caller ID --key ID --provider ID --model ID [--model ID] [--reasoning passthrough|off] [--name 名称]
  edit --caller ID [--provider ID] [--model ID ...] [--reasoning passthrough|off] [--name 名称]
  rollback-providers --provider ID [--provider ID ...]  停服后备份并移除指定非 CLP 引用及其 Key，禁止恢复旧凭据
  rollback-retired               停服后备份并移除历史身份摘要，保留当前凭据与删除结果
  rollback-names                 停服后备份并移除用途名称，保留当前凭据
  rollback-reasoning             停服后备份并移除思考策略，保留当前凭据
  rotate --caller ID             轮换并启用新秘密，保留身份
  delete --caller ID             删除调用方并撤销密钥；保留历史指标和转储
  disable [--caller ID]           禁用调用方；省略 caller 则禁用服务
  enable                         启用服务配置（安装与启动通过 service）
所有命令支持 -h/--help；新秘密仅在成功保存后输出一次。`;

export function parseModelRelayCommand(args) {
  const [command, ...rest] = args;
  const commands = ["status", "providers", "callers", "issue", "rotate", "delete", "disable", "enable", "upgrade-limits", "edit", "rollback-reasoning", "rollback-names", "rollback-providers", "rollback-retired"];
  if (!commands.includes(command)) throw new Error(modelRelayUsage);
  const allowed = command === "issue" ? ["--caller", "--key", "--provider", "--model", "--reasoning", "--name"]
    : command === "edit" ? ["--provider", "--caller", "--model", "--reasoning", "--name"]
    : command === "rollback-providers" ? ["--provider"]
    : ["rotate", "delete", "disable"].includes(command) ? ["--caller"] : [];
  const options = { models: [] };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("--")) throw new Error(modelRelayUsage);
    if (command === "rollback-providers" && flag === "--provider") (options.providers ??= []).push(value);
    else if (flag === "--model") options.models.push(value);
    else {
      const key = flag.slice(2);
      if (options[key] !== undefined) throw new Error("Relay 参数不能重复");
      options[key] = value;
    }
  }
  if (command === "rollback-providers" && !options.providers?.length
    || command === "issue" && (!options.caller || !options.key || !options.provider || !options.models.length)
    || ["rotate", "edit", "delete"].includes(command) && !options.caller
    || command === "edit" && !options.models.length && options.reasoning === undefined && options.name === undefined && options.provider === undefined
    || options.reasoning !== undefined && !["passthrough", "off"].includes(options.reasoning)) throw new Error(modelRelayUsage);
  return { command, ...options };
}

export async function runModelRelayCommand(args) {
  if (!args.length || isCommandHelp(args, [[], ...["status", "providers", "callers", "issue", "rotate", "delete", "disable", "enable", "upgrade-limits", "edit", "rollback-reasoning", "rollback-names", "rollback-providers", "rollback-retired"].map(command => [command])], modelRelayUsage)) { console.log(modelRelayUsage); return; }
  const input = parseModelRelayCommand(args);
  console.log(JSON.stringify(await manageModelRelay(input), null, 2));
}
