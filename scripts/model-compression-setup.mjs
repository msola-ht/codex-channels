import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelCompression,
} from "../runtime/model-provider-runtime.mjs";
import {
  applyModelCompressionChange,
} from "./model-compression-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

class ModelCompressionSetupCancelled extends Error {}

export async function runModelCompressionSetup({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  prompter,
} = {}) {
  const models = loadManagedModelCompression(environment);
  if (models.length === 0) {
    throw new Error("尚未配置受管第三方模型，请先配置 DeepSeek 或 OpenCode Go");
  }
  const prompt = prompter ?? createPrompter(prompts, models, { allowBack });
  try {
    const model = await prompt.selectModel();
    if (model === "back") return { action: "back" };
    const selected = models.find((candidate) => candidate.model === model);
    if (!selected) throw new Error(`未找到已配置模型：${model}`);
    const autoCompactPercent = await prompt.selectAutoCompactPercent(selected);
    const result = await applyModelCompressionChange({
      model: selected.model,
      autoCompactPercent,
    }, { environment });
    output.write(`${selected.displayName} 自动压缩阈值：${autoCompactPercent}%（约 ${result.autoCompactLimit} tokens）。\n`);
    output.write(`应用 Provider：${result.providers.join("、")}。\n`);
    if (result.conflicts === true) {
      output.write(`注意：已覆盖不同 Provider 上不一致的压缩值（${result.overridden.map((entry) => `${entry.provider} ${entry.previousPercent}%`).join("；")}）。\n`);
    }
    output.write("同名模型在所有 Provider 共用同一压缩值。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-app-server"));
    return {
      action: "configured",
      model: result.model.id,
      autoCompactPercent,
      autoCompactLimit: result.autoCompactLimit,
      providers: result.providers,
      activation: "restart-app-server",
      activationResult: configActivationResult("restart-app-server"),
    };
  } catch (error) {
    if (allowBack && error instanceof ModelCompressionSetupCancelled) {
      return { action: "back" };
    }
    throw error;
  }
}

function createPrompter(prompts, models, { allowBack }) {
  return {
    selectModel: async () => {
      const value = await prompts.select({
        message: "选择模型（按模型名全局统一）",
        options: [
          ...models.map((model) => ({
            value: model.model,
            label: model.displayName,
            hint: [
              `Provider：${model.providers.join("、") || "无"}`,
              `上下文窗口：${model.contextWindow.toLocaleString()} tokens`,
              model.autoCompactPercent === undefined
                ? "当前：默认"
                : `当前：${model.autoCompactPercent}%`,
              model.conflicts === true ? "压缩值不一致" : "",
            ].filter(Boolean).join(" · "),
          })),
          ...(allowBack ? [{ value: "back", label: "返回上一级" }] : []),
        ],
      });
      return requirePromptValue(prompts, value);
    },
    selectAutoCompactPercent: async (model) => {
      const current = model.autoCompactPercent ?? 60;
      const value = await prompts.text({
        message: [
          `${model.displayName} 自动压缩百分比`,
          model.autoCompactPercent === undefined
            ? "当前：默认（未设置）"
            : `当前：${model.autoCompactPercent}%`,
          "范围 10-90",
        ].join(" · "),
        initialValue: String(current),
        validate: (input) => {
          const parsed = Number(input);
          return Number.isInteger(parsed) && parsed >= 10 && parsed <= 90
            ? undefined
            : "请输入 10 到 90 的整数";
        },
      });
      return Number(requirePromptValue(prompts, value));
    },
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelCompressionSetupCancelled("模型自动压缩设置已取消");
  }
  return value;
}
