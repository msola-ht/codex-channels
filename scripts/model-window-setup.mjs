import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelWindow,
} from "../runtime/model-provider-runtime.mjs";
import {
  applyModelWindowChange,
  previewModelWindowChange,
} from "./model-window-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { promptContextWindow } from "./responses-model-setup.mjs";

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
    throw new Error("尚未配置受管第三方模型，请先在 Setup 中完成第三方账户接入");
  }
  const prompt = prompter ?? createPrompter(prompts, models, { allowBack });
  try {
    const model = await prompt.selectModel();
    if (model === "back") return { action: "back" };
    const selected = models.find((candidate) => candidate.model === model);
    if (!selected) throw new Error(`未找到已配置模型：${model}`);
    const preview = previewModelWindowChange({ model: selected.model, contextWindow: selected.contextWindow }, { environment });
    output.write(`本次窗口设置影响的 Provider（含上下文跟随者）：${preview.providers.join("、")}。\n`);
    if (preview.conflicts) {
      output.write(`保存将统一当前不一致的窗口：${preview.overridden.map((entry) => `${entry.provider} ${entry.previousPercent}%`).join("；")}。\n`);
    }
    const contextWindow = await prompt.selectContextWindow(selected);
    const result = await applyModelWindowChange({
      model: selected.model,
      contextWindow,
    }, { environment });
    output.write(`${selected.displayName} 上下文窗口：${result.contextWindow} Token（模型最大值 ${result.model.maxContextWindow} Token）。\n`);
    output.write(`应用 Provider：${result.providers.join("、")}。\n`);
    if (result.conflicts === true) {
      output.write(`注意：已覆盖不同 Provider 上不一致的窗口占比（${result.overridden.map((entry) => `${entry.provider} ${entry.previousPercent}%`).join("；")}）。\n`);
    }
    output.write("已统一上述 Provider 的模型窗口及上下文跟随设置；既有自动压缩阈值保持不变。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-app-server"));
    return {
      action: "configured",
      model: result.model.id,
      windowPercent: result.windowPercent,
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
              model.conflicts === true ? "窗口大小不一致" : "",
            ].filter(Boolean).join(" · "),
          })),
          ...(allowBack ? [{ value: "back", label: "返回上一级" }] : []),
        ],
      });
      return requirePromptValue(prompts, value);
    },
    selectContextWindow: async (model) => {
      const value = await promptContextWindow(prompts, model.displayName, model.contextWindow,
        model.maxContextWindow, { includeMaximum: true });
      if (value === undefined) throw new ModelWindowSetupCancelled("模型上下文窗口设置已取消");
      return value;
    },
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelWindowSetupCancelled("模型上下文窗口设置已取消");
  }
  return value;
}
