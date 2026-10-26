import { isCommandHelp } from "./cli-help.mjs";
import { discoverOllamaCloudModels } from "./ollama-cloud-catalog.mjs";

export const ollamaCloudUsage = "用法：codexc provider ollama-cloud discover [--json]\n仅发现公开元数据候选，不验证 Key、不启用模型、不写入配置。";

export async function runOllamaCloudCommand(args, { output = process.stdout, signal } = {}) {
  if (args.length === 0 || isCommandHelp(args, [[], ["discover"]], ollamaCloudUsage)) {
    output.write(`${ollamaCloudUsage}\n`);
    return;
  }
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
