import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelWindow,
} from "../runtime/model-provider-runtime.mjs";
import {
  applyModelWindowChange,
} from "./model-window-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

class ModelWindowSetupCancelled extends Error {}

export async function runModelWindowSetup({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  prompter,
} = {}) {
  const models = loadManagedModelWindow(environment);
  if (models.length === 0) {
    throw new Error("尚未配置受管第三方模型，请先配置 DeepSeek 或 OpenCode Go");
  }
  const prompt = prompter ?? createPrompter(prompts, models, { allowBack });
  try {
    const model = await prompt.selectModel();
    if (model === "back") return { action: "back" };
    const selected = models.find((candidate) => candidate.model === model);
    if (!selected) throw new Error(`未找到已配置模型：${model}`);
    const windowPercent = await prompt.selectWindowPercent(selected);
    const result = await applyModelWindowChange({
      model: selected.model,
      windowPercent,
    }, { environment });
    output.write(`${selected.displayName} 上下文窗口：${windowPercent}%（${result.contextWindow} tokens，模型最大值 ${result.model.maxContextWindow} tokens）。\n`);
    output.write(`应用 Provider：${result.providers.join("、")}。\n`);
    if (result.conflicts === true) {
      output.write(`注意：已覆盖不同 Provider 上不一致的窗口占比（${result.overridden.map((entry) => `${entry.provider} ${entry.previousPercent}%`).join("；")}）。\n`);
    }
    output.write("同名模型在所有 Provider 共用同一窗口；自动压缩使用上游默认。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-app-server"));
    return {
      action: "configured",
      model: result.model.id,
      windowPercent,
      contextWindow: result.contextWindow,
      providers: result.providers,
      activation: "restart-app-server",
      activationResult: configActivationResult("restart-app-server"),
    };
  } catch (error) {
    if (allowBack && error instanceof ModelWindowSetupCancelled) {
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
              `最大窗口：${model.maxContextWindow.toLocaleString()} tokens`,
              `当前窗口：${model.contextWindow.toLocaleString()} tokens`,
              model.windowPercent === undefined
                ? "当前：官方窗口"
                : `当前：${model.windowPercent}%`,
              model.conflicts === true ? "窗口占比不一致" : "",
            ].filter(Boolean).join(" · "),
          })),
          ...(allowBack ? [{ value: "back", label: "返回上一级" }] : []),
        ],
      });
      return requirePromptValue(prompts, value);
    },
    selectWindowPercent: async (model) => {
      const current = model.windowPercent ?? 100;
      const value = await prompts.text({
        message: [
          `${model.displayName} 上下文窗口占比`,
          model.windowPercent === undefined
            ? `当前：官方窗口（${model.contextWindow.toLocaleString()} tokens）`
            : `当前：${model.windowPercent}%（${model.contextWindow.toLocaleString()} tokens）`,
          `按模型最大窗口 ${model.maxContextWindow.toLocaleString()} tokens 换算`,
          "范围 10-100，100% 为模型官方窗口；自动压缩使用上游默认",
        ].join(" · "),
        initialValue: String(current),
        validate: (input) => {
          const parsed = Number(input);
          return Number.isInteger(parsed) && parsed >= 10 && parsed <= 100
            ? undefined
            : "请输入 10 到 100 的整数";
        },
      });
      return Number(requirePromptValue(prompts, value));
    },
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelWindowSetupCancelled("模型上下文窗口设置已取消");
  }
  return value;
}
