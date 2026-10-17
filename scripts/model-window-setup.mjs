import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelWindow,
} from "../runtime/model-provider-runtime.mjs";
import {
  applyModelWindowChange,
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
    const selected = models.find((candidate) => modelKey(candidate) === model);
    if (!selected) throw new Error(`未找到已配置模型：${model}`);
    output.write(`本次窗口设置的 Provider：${selected.provider}。\n`);
    const contextWindow = await prompt.selectContextWindow(selected);
    const result = await applyModelWindowChange({
      provider: selected.provider,
      model: selected.model,
      contextWindow,
    }, { environment });
    output.write(`${selected.displayName} 上下文窗口：${result.contextWindow} Token（模型最大值 ${result.model.maxContextWindow} Token）。\n`);
    output.write(`应用 Provider：${result.providers.join("、")}。\n`);
    output.write("已设置所选 Provider 的模型窗口；既有自动压缩阈值保持不变。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-app-server"));
    return {
      action: "configured",
      provider: result.provider,
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
        message: "选择 Provider 与模型",
        options: [
          ...models.map((model) => ({
            value: modelKey(model),
            label: `${model.displayName}（${model.provider}）`,
            hint: [
              `Provider：${model.provider}`,
              `最大窗口：${model.maxContextWindow.toLocaleString()} tokens`,
              `当前窗口：${model.contextWindow.toLocaleString()} tokens`,
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

function modelKey(model) {
  return JSON.stringify([model.provider, model.model]);
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelWindowSetupCancelled("模型上下文窗口设置已取消");
  }
  return value;
}
