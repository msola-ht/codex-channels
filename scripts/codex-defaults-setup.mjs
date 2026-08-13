import * as clackPrompts from "@clack/prompts";

import { loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";

export async function runCodexDefaultsSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  allowBack = false,
  createClient = createCodexUserConfigClient,
  primaryProvider = loadPrimaryModelProvider,
} = {}) {
  if (primaryProvider(environment) !== "openai") {
    throw new Error(
      "当前是仅 DeepSeek 固定模式；请先恢复 OpenAI 默认配置，再设置 Codex 官方模型",
    );
  }
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [models, current] = await Promise.all([
      client.listModels(),
      client.readDefaultModelSettings(),
    ]);
    const availableModels = models.filter((model) => model.available !== false);
    if (availableModels.length === 0) {
      throw new Error("Codex App Server 没有返回可用的官方模型");
    }
    const fallbackModel = availableModels.find((model) => model.model === current.model)
      ?? availableModels.find((model) => model.isDefault)
      ?? availableModels[0];
    const selectedModel = await prompts.select({
      message: "选择 Codex 全局默认模型",
      showInstructions: false,
      initialValue: fallbackModel.model,
      options: [
        ...availableModels.map((model) => ({
          value: model.model,
          label: model.displayName,
          hint: model.model,
        })),
        ...(allowBack ? [{ value: "back", label: "返回", hint: "返回设置类别" }] : []),
      ],
    });
    if (prompts.isCancel(selectedModel) || selectedModel === "back") {
      return { action: "back" };
    }
    const model = availableModels.find((candidate) => candidate.model === selectedModel);
    if (!model) {
      throw new Error("选择的 Codex 官方模型已经不可用");
    }
    if (model.supportedReasoningEfforts.length === 0) {
      throw new Error(`Codex 模型没有返回可用思考等级：${model.model}`);
    }
    const currentEffort = model.model === current.model
      && model.supportedReasoningEfforts.some((option) => option.effort === current.effort)
      ? current.effort
      : model.defaultReasoningEffort;
    const selectedEffort = await prompts.select({
      message: `选择 ${model.displayName} 的全局默认思考等级`,
      showInstructions: false,
      initialValue: currentEffort,
      options: [
        ...model.supportedReasoningEfforts.map((option) => ({
          value: option.effort,
          label: option.effort,
          hint: option.description,
        })),
        ...(allowBack ? [{ value: "back", label: "返回", hint: "返回设置类别" }] : []),
      ],
    });
    if (prompts.isCancel(selectedEffort) || selectedEffort === "back") {
      return { action: "back" };
    }
    if (!model.supportedReasoningEfforts.some((option) => option.effort === selectedEffort)) {
      throw new Error(`当前模型不支持该思考等级：${String(selectedEffort)}`);
    }
    const confirmed = await prompts.confirm({
      message: `保存 Codex 全局默认设置：${model.model} · ${selectedEffort}？`,
      initialValue: true,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
      output.write("已取消，未修改 Codex 全局配置。\n");
      return undefined;
    }
    await client.writeDefaultModelSettings(model.model, selectedEffort);
    output.write(`Codex 全局默认设置已更新：${model.model} · ${selectedEffort}\n`);
    output.write("请运行 codexc service restart all，使 App Server 新会话使用新默认值。\n");
    return { model: model.model, effort: selectedEffort };
  } finally {
    await client.close().catch(() => undefined);
  }
}
