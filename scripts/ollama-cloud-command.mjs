import { isCommandHelp } from "./cli-help.mjs";
import { discoverOllamaCloudModels } from "./ollama-cloud-catalog.mjs";
import { loadOllamaCloudAccounts, ollamaCloudProviderId } from "../runtime/ollama-cloud-accounts.mjs";
import { runOllamaCloudSetup } from "./ollama-cloud-setup.mjs";

export const ollamaCloudUsage = "用法：codexc provider ollama-cloud <setup|add|list|reconfigure|remove|default|discover> [id]\nlist/discover 支持 --json；setup 交互管理账户与模型；add/reconfigure/remove/default 接受账户 ID。\n新增账户必须明确选择共享目录模型；首次目录手动声明能力。新增或更换 Key 的预览及保存读取认证接口，不发送推理请求。discover 仅发现公开候选，不启用模型。";

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
  if (args[0] !== "discover" || args.length > 2 || args.length === 2 && args[1] !== "--json") throw new Error(ollamaCloudUsage);
  const result = await discoverOllamaCloudModels({ signal });
  if (args[1] === "--json") output.write(`${JSON.stringify(result)}\n`);
  else {
    output.write("Ollama Cloud 公开模型候选（尚未验证 Responses 能力；未写入配置）\n");
    for (const model of result.candidates) {
      output.write(`${JSON.stringify(model.id)}：${model.status === "candidate" ? `待验证，窗口候选 ${model.proposedContextWindow}（本地策略上限 393216），思考 ${model.reasoningEfforts.join("/")}` : model.reason}\n`);
    }
    if (result.unmatchedTags.length) output.write(`tags 中另有 ${result.unmatchedTags.length} 个未匹配模型，未加入候选。\n`);
  }
}
