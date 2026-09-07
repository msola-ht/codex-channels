import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelProviderSettings,
} from "../runtime/model-provider-runtime.mjs";
import {
  readCodexUserConfigSnapshot,
  writeCodexUserConfigEdits,
} from "./codex-user-config.mjs";
import {
  applyManagedProviderDefaultChange,
} from "./model-provider-default-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

class ModelProviderDefaultSetupCancelled extends Error {}

export async function runModelProviderDefaultSetup({
  allowBack = false,
  provider: preselectedProvider,
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  prompter,
  readConfigSnapshot = readCodexUserConfigSnapshot,
  writeConfigEdits = writeCodexUserConfigEdits,
} = {}) {
  const configured = loadManagedModelProviderSettings(environment);
  if (configured.length === 0) {
    throw new Error("尚未配置第三方 Provider，请先配置 DeepSeek 或 OpenCode Go");
  }
  const prompt = prompter ?? createPrompter(prompts, configured, { allowBack });
  try {
    const provider = preselectedProvider
      ?? await prompt.selectProvider();
    if (provider === "back") return { action: "back" };
    const selected = configured.find((candidate) => candidate.provider === provider);
    if (!selected) throw new Error(`第三方 Provider 未配置：${provider}`);
    const model = await prompt.selectModel(selected);
    const selectedModel = selected.models.find((candidate) => candidate.model === model);
    if (!selectedModel) {
      throw new Error(`${selected.displayName} 不支持模型：${model}`);
    }
    const reasoningEffort = await prompt.selectReasoningEffort(selected, selectedModel);
    const result = await applyManagedProviderDefaultChange({
      provider: selected.provider,
      model,
      reasoningEffort,
    }, {
      environment,
      loadProviders: () => configured,
      readConfigSnapshot,
      writeConfigEdits,
    });
    output.write(`${selected.displayName} 默认模型已设为 ${model}。\n`);
    output.write(`模型上下文：${selectedModel.contextWindow} tokens。\n`);
    output.write(`默认思考等级：${reasoningEffort}。\n`);
    output.write("新会话使用该默认值；恢复历史会话仍使用 Thread 原有模型。\n");
    output.write("自动压缩请在「模型自动压缩」中按模型名统一设置。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-app-server"));
    return {
      action: "configured",
      provider: selected.provider,
      model,
      reasoningEffort,
      mode: result.provider.mode,
      activation: "restart-app-server",
      activationResult: configActivationResult("restart-app-server"),
    };
  } catch (error) {
    if (allowBack && error instanceof ModelProviderDefaultSetupCancelled) {
      return { action: "back" };
    }
    throw error;
  }
}

function createPrompter(prompts, configured, { allowBack }) {
  return {
    selectProvider: async () => {
      const value = await prompts.select({
        message: "选择第三方 Provider",
        options: [
          ...configured.map((provider) => ({
            value: provider.provider,
            label: provider.displayName,
            hint: `当前默认：${provider.model}`,
          })),
          ...(allowBack ? [{ value: "back", label: "返回上一级" }] : []),
        ],
      });
      return requirePromptValue(prompts, value);
    },
    selectModel: async (provider) => {
      const value = await prompts.select({
        message: `选择 ${provider.displayName} 默认模型`,
        initialValue: provider.model,
        options: provider.models.map((model) => ({
          value: model.model,
          label: model.displayName,
          ...(model.model === provider.model ? { hint: "当前默认" } : {}),
        })),
      });
      return requirePromptValue(prompts, value);
    },
    selectReasoningEffort: async (_provider, model) => {
      const value = await prompts.select({
        message: `选择 ${model.displayName} 默认思考等级`,
        initialValue: model.reasoningEffort,
        options: model.reasoningEfforts.map((option) => ({
          value: option.effort,
          label: option.effort,
          hint: option.description,
        })),
      });
      return requirePromptValue(prompts, value);
    },
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelProviderDefaultSetupCancelled("第三方模型设置已取消");
  }
  return value;
}
