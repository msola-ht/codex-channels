import * as clackPrompts from "@clack/prompts";
import { join } from "node:path";
import { loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";

import {
  loadManagedModelProviderSettings,
  managedProviderDirectory,
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
    throw new Error("尚未配置受管 Provider，请先在 Setup 中完成第三方账户接入");
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
    output.write("默认模型只修改所选账户；该模型的默认思考等级由共享模型目录的账户共用，其他账户使用同一模型时也会采用新等级。\n");
    const definitions = loadManagedModelProviderDefinitions(environment);
    const definition = definitions.find((entry) => entry.id === selected.provider);
    if (!definition) throw new Error("Provider 定义已变化，请重新选择");
    const catalogPath = join(managedProviderDirectory(environment, definition), definition.catalogFileName);
    const sharedIds = new Set(definitions.filter((entry) =>
      join(managedProviderDirectory(environment, entry), entry.catalogFileName) === catalogPath).map((entry) => entry.id));
    output.write(`当前共享目录且包含此模型的账户：${configured.filter((entry) => sharedIds.has(entry.provider)
      && entry.models.some((candidate) => candidate.model === model)).map((entry) => entry.displayName).join("、")}。\n`);
    const reasoningEffort = await prompt.selectReasoningEffort(selected, selectedModel);
    const result = await applyManagedProviderDefaultChange({
      provider: selected.provider,
      model,
      reasoningEffort,
    }, {
      environment,
      loadProviders: () => {
        const current = loadManagedModelProviderSettings(environment);
        if (current.find((candidate) => candidate.provider === selected.provider)?.mode !== selected.mode) {
          throw new Error("Provider 模式已变化，请重新选择并设置默认模型");
        }
        return current;
      },
      readConfigSnapshot,
      writeConfigEdits,
    });
    output.write(`${result.provider.displayName} 默认模型已设为 ${result.model.id}。\n`);
    output.write(`模型上下文：${result.model.contextWindow} tokens。\n`);
    output.write(`共享模型目录中的默认思考等级：${reasoningEffort}。\n`);
    output.write("新会话使用该默认值；恢复历史会话仍使用 Thread 原有模型。\n");
    output.write("已清除当前主配置或 Provider Profile 的上下文窗口与自动压缩覆盖，恢复模型目录与上游默认规则；窗口请在「受管模型目录上下文窗口」中按模型名统一设置。\n");
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
