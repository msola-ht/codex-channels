import { isCommandHelp } from "./cli-help.mjs";
import { loadOllamaCloudModels } from "./ollama-cloud-catalog.mjs";
import { withOllamaCloudFetch } from "./ollama-cloud-model-verification.mjs";
import { loadOllamaCloudAccounts, ollamaCloudProviderId } from "../runtime/ollama-cloud-accounts.mjs";
import { runOllamaCloudSetup } from "./ollama-cloud-setup.mjs";

export const ollamaCloudUsage = "用法：codexc provider ollama-cloud <setup|add|list|reconfigure|remove|default|discover> [id]\nlist/discover 支持 --json；discover 支持 --refresh 强制刷新一小时公开元数据缓存；setup 交互管理账户与模型；add/reconfigure/remove/default 接受账户 ID。\n首次账户从远端列表选择模型，自动读取能力并只创建所选模型；已有目录新增账户复用目录。新增或更换 Key 的预览及保存读取认证接口，不发送推理请求。discover 仅读取或更新公开缓存，不启用模型。";

export async function runOllamaCloudCommand(args, options = {}) {
  const { output = process.stdout, signal, environment = process.env } = options;
  if (args.length === 0 || isCommandHelp(args, [[], ...["discover", "setup", "add", "list", "reconfigure", "remove", "default"].map(value => [value])], ollamaCloudUsage)) {
    output.write(`${ollamaCloudUsage}\n`);
    return;
  }
  if (args[0] === "setup" && args.length === 1) return runOllamaCloudSetup(options);
  if (args[0] === "list" && (args.length === 1 || args.length === 2 && args[1] === "--json")) {
    const accounts = loadOllamaCloudAccounts(environment);
    output.write(args[1] === "--json" ? `${JSON.stringify(accounts)}\n` : `${accounts.map(account => `${ollamaCloudProviderId(account.id)}${account.default ? "（默认）" : ""}`).join("\n") || "尚未配置 Ollama Cloud 账户"}\n`);
    return;
  }
  if (["add", "reconfigure", "remove", "default"].includes(args[0]) && args.length === 2) return runOllamaCloudSetup({ ...options, action: args[0], accountId: args[1] });
  const flags = args.slice(1);
  if (args[0] !== "discover" || flags.length > 2 || new Set(flags).size !== flags.length
    || flags.some(flag => !["--json", "--refresh"].includes(flag))) throw new Error(ollamaCloudUsage);
  const operationSignal = globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
  const result = await withOllamaCloudFetch(environment, operationSignal,
    fetch => loadOllamaCloudModels({ environment, refresh: flags.includes("--refresh"), signal: operationSignal, fetchImpl: fetch }), options.fetchImpl);
  if (flags.includes("--json")) output.write(`${JSON.stringify(result)}\n`);
  else {
    output.write("Ollama Cloud 公开模型候选（元数据声明；默认启用 Responses 工具适配，未执行推理验证或写入配置）\n");
    output.write(`${result.cache.hit ? "使用本地缓存" : "已刷新公开缓存"}；获取 ${result.cache.fetchedAt}；有效至 ${result.cache.expiresAt}。需要立即同步可使用 discover --refresh。\n`);
    for (const model of result.candidates) {
      output.write(`${JSON.stringify(model.id)}：${model.status === "candidate" ? `可添加，上游窗口 ${model.upstreamContextWindow}，配置窗口 ${model.proposedContextWindow}（本地策略上限 393216），思考 ${model.reasoningEfforts.join("/")}（默认 ${model.defaultReasoningEffort}）${model.reasoningMode === "toggle" ? "；开关兼容值 none=关闭、high=开启，不表示强度" : ""}，图片 ${model.imageCandidate ? "支持" : "不支持"}` : model.reason}\n`);
    }
    if (result.unmatchedTags.length) output.write(`tags 中另有 ${result.unmatchedTags.length} 个未匹配模型，未加入候选。\n`);
  }
}
