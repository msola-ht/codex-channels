import * as clackPrompts from "@clack/prompts";
import { isDeepStrictEqual } from "node:util";

import {
  loadManagedModelProviderSettings,
} from "../runtime/model-provider-runtime.mjs";
import {
  readCodexUserConfigSnapshot,
  writeCodexUserConfigEdits,
} from "./codex-user-config.mjs";
import {
  applyManagedProviderDefaultChange,
  previewManagedProviderDefaultChange,
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
    const reasoningEffort = await prompt.selectReasoningEffort(selected, selectedModel);
    if (!isDeepStrictEqual(selected, loadManagedModelProviderSettings(environment).find(candidate => candidate.provider === selected.provider))) {
      throw new Error("账户或模型目录在选择期间已变化，请重新打开默认模型设置");
    }
    const input = {
      provider: selected.provider,
      model,
      reasoningEffort,
    };
    const preview = previewManagedProviderDefaultChange(input, { environment });
    output.write(`默认模型仅设置账户：${preview.effects.defaultModelProviders.join("、")}；${preview.before.defaultModel} → ${model}。\n`);
    output.write(`共享模型 ${model} 的默认思考等级：${preview.before.reasoningEffort} → ${reasoningEffort}；影响账户：${preview.effects.reasoningEffortProviders.join("、")}。\n`);
    output.write(`默认选择此模型的 Profile 等级同步账户：${preview.effects.profileReasoningEffortProviders.join("、") || "无"}。\n`);
    output.write("保存时清除所选账户的上下文窗口与自动压缩覆盖，恢复目录与上游默认规则。\n");
    if (await prompt.confirm(preview) !== true) return { action: "back" };
    const result = await applyManagedProviderDefaultChange(input, {
      environment,
      preview,
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
    output.write(`共享模型 ${model} 的默认思考等级：${reasoningEffort}；影响账户：${result.effects.reasoningEffortProviders.join("、")}。\n`);
    output.write("新会话使用该默认值；恢复历史会话仍使用 Thread 原有模型。\n");
    output.write("已清除当前主配置或 Provider Profile 的上下文窗口与自动压缩覆盖，恢复模型目录与上游默认规则；窗口请在「受管模型目录上下文窗口」中选择具体 Provider 与模型设置。\n");
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
    confirm: async () => requirePromptValue(prompts, await prompts.confirm({
      message: "确认保存账户默认模型与共享模型思考等级？",
      initialValue: false,
    })),
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelProviderDefaultSetupCancelled("第三方模型设置已取消");
  }
  return value;
}
