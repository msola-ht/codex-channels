import * as clackPrompts from "@clack/prompts";

import {
  loadProviderModelCatalogPresentations,
  previewProviderModelContextChange,
  applyProviderModelContextChange,
} from "./provider-model-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { promptContextWindow } from "./responses-model-setup.mjs";
import { managedProviderAccountFamilies } from "../runtime/model-provider-definitions.mjs";

class ModelWindowSetupCancelled extends Error {}

export async function runModelWindowSetup({
  allowBack = false,
  provider,
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  prompter,
} = {}) {
  const { catalogs } = await loadProviderModelCatalogPresentations({ environment });
  const models = catalogs.filter(catalog => catalog.source === "managed"
    && (provider === undefined || catalog.providers.includes(provider))).flatMap(catalog =>
    catalog.models.filter(model => Number.isSafeInteger(model.presentation.maxContextWindow)).map(model => ({
      provider: catalog.provider,
      providers: catalog.providers,
      revision: catalog.revision,
      model: model.id,
      displayName: model.displayName,
      contextWindow: model.presentation.contextWindow,
      maxContextWindow: model.presentation.maxContextWindow,
    })));
  if (models.length === 0) {
    throw new Error("没有可编辑上下文窗口的受管模型，请先完成接入并确认目录声明了最大窗口");
  }
  const prompt = prompter ?? createPrompter(prompts, models, { allowBack });
  try {
    const model = await prompt.selectModel();
    if (model === "back") return { action: "back" };
    const selected = models.find((candidate) => modelKey(candidate) === model);
    if (!selected) throw new Error(`未找到已配置模型：${model}`);
    output.write(`本次窗口设置影响同一提供商账户：${selected.providers.join("、")}。\n`);
    const contextWindow = await prompt.selectContextWindow(selected);
    const input = {
      provider: selected.provider,
      model: selected.model,
      contextWindow,
      revision: selected.revision,
    };
    const preview = await previewProviderModelContextChange(input, { environment });
    output.write(`${preview.model.displayName} 上下文窗口：${preview.model.contextWindow} → ${preview.contextWindow} Token。\n`);
    output.write(`影响同一提供商账户：${preview.providers.join("、")}；既有自动压缩阈值保持不变。\n`);
    if (await prompt.confirmSave(preview) !== true) return { action: "back" };
    const result = await applyProviderModelContextChange(input, { environment, preview });
    output.write(`${selected.displayName} 上下文窗口：${result.contextWindow} Token（模型最大值 ${result.model.maxContextWindow} Token）。\n`);
    output.write(`应用 Provider：${result.providers.join("、")}。\n`);
    output.write(result.action === "unchanged" ? "模型窗口未变化，无需保存或重启。\n" : "已设置所选 Provider 的模型窗口；既有自动压缩阈值保持不变。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
    return {
      action: result.action === "unchanged" ? "unchanged" : "configured",
      provider: result.provider,
      model: result.model.id,
      windowPercent: result.contextWindow * 100 / result.model.maxContextWindow,
      contextWindow: result.contextWindow,
      providers: result.providers,
      activation: result.activation,
      activationResult: configActivationResult(result.activation),
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
        message: "选择提供商与模型",
        options: [
          ...models.map((model) => ({
            value: modelKey(model),
            label: `${model.displayName}（${managedProviderAccountFamilies.find(family => family.matches(model.provider))?.definition.displayName ?? model.provider}）`,
            hint: [
              `影响账户：${model.providers.join("、")}`,
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
    confirmSave: async () => requirePromptValue(prompts, await prompts.confirm({
      message: "确认保存上述模型上下文窗口？",
      initialValue: false,
    })),
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
