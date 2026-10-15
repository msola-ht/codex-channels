import { runRelayListenMenu } from "./model-relay-listen-menu.mjs";
import { isCommandHelp } from "./cli-help.mjs";
import { manageModelRelay } from "./model-relay-management.mjs";
import { relayModelReasoningMapSchema } from "../runtime/model-relay-config.mjs";
export { manageModelRelay } from "./model-relay-management.mjs";

export const modelRelayUsage = `用法：codexc relay <命令>
  status                         查询进程、监听、请求队列与指标确认状态
  providers                      列出可用上游、模型和关闭思考能力
  callers                        列出调用方（不显示秘密或哈希）
  issue --caller ID --key ID --model 提供商/模型ID [--model ID ...] [--model-reasoning JSON | --reasoning passthrough|off] [--name 名称]
  edit --caller ID [--model ID ...] [--model-reasoning JSON | --reasoning passthrough|off] [--name 名称]
  rotate --caller ID             轮换并启用新秘密，保留身份
  delete --caller ID             删除调用方并撤销密钥；保留历史指标和转储
  disable [--caller ID]           禁用调用方；省略 caller 则禁用服务
  listen                         交互设置：关闭、仅本机、局域网或指定内网 IP
  enable                         启用服务配置（安装用 codexc install，单独启动用 codexc start relay）
--model-reasoning 接受单个 JSON 对象，键须完整匹配所选模型，值为 passthrough|off|minimal|low|medium|high|xhigh|max
或 off-reasoning-effort|off-reasoning-enabled|off-reasoning-effort-field|off-thinking|off-enable-thinking。
edit 省略 --model 时须匹配当前全部模型。--reasoning 设置整把 Key 策略并清除逐模型策略，两种参数不可同时使用。
所有命令支持 -h/--help；新秘密仅在成功保存后输出一次。`;

export function parseModelRelayCommand(args) {
  const [command, ...rest] = args;
  const commands = ["listen", "status", "providers", "callers", "issue", "rotate", "delete", "disable", "enable", "edit"];
  if (!commands.includes(command)) throw new Error(modelRelayUsage);
  const allowed = command === "issue" ? ["--caller", "--key", "--reasoning", "--model-reasoning", "--name", "--model"]
    : command === "edit" ? ["--caller", "--reasoning", "--model-reasoning", "--name", "--model"]
    : ["rotate", "delete", "disable"].includes(command) ? ["--caller"] : [];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("--")) throw new Error(modelRelayUsage);
    if (flag === "--model") (options.models ??= []).push(value);
    else {
      const key = flag === "--model-reasoning" ? "modelReasoning" : flag.slice(2);
      if (options[key] !== undefined) throw new Error("Relay 参数不能重复");
      if (flag === "--model-reasoning") {
        let parsed;
        try { parsed = relayModelReasoningMapSchema.safeParse(JSON.parse(value)); }
        catch { throw new Error("--model-reasoning 须为逐模型思考策略 JSON 对象"); }
        if (!parsed.success) throw new Error("--model-reasoning 包含无效模型、策略或超过数量限制");
        options.modelReasoning = parsed.data;
      } else options[key] = value;
    }
  }
  if (command === "issue" && (!options.caller || !options.key || !options.models?.length)
    || ["rotate", "edit", "delete"].includes(command) && !options.caller
    || command === "edit" && options.reasoning === undefined && options.modelReasoning === undefined && options.name === undefined && options.models === undefined
    || options.reasoning !== undefined && options.modelReasoning !== undefined
    || options.reasoning !== undefined && !["passthrough", "off"].includes(options.reasoning)) throw new Error(modelRelayUsage);
  if (options.modelReasoning !== undefined && options.models !== undefined
    && (new Set(options.models).size !== options.models.length || Object.keys(options.modelReasoning).length !== options.models.length
      || options.models.some(id => !Object.hasOwn(options.modelReasoning, id)))) {
    throw new Error("--model-reasoning 须完整匹配 --model 选择的模型");
  }
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
