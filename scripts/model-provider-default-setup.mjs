import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelProviderSettings,
  writeManagedModelProviderCatalogSettings,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";
import { writeCodexUserConfigEdits } from "./codex-user-config.mjs";

class ModelProviderDefaultSetupCancelled extends Error {}

export async function runModelProviderDefaultSetup({
  allowBack = false,
  provider: preselectedProvider,
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  prompter,
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
    const autoCompactPercent = await prompt.selectAutoCompactPercent(selected, selectedModel);
    if (
      !Number.isInteger(autoCompactPercent)
      || autoCompactPercent < 10
      || autoCompactPercent > 90
    ) {
      throw new Error(`${selected.displayName} 模型自动压缩百分比无效`);
    }
    const settings = {
      model,
      reasoningEffort,
      autoCompactLimit: Math.round(selectedModel.contextWindow * autoCompactPercent / 100),
    };
    if (selected.mode === "switching") {
      writeManagedModelProviderProfileDefault(selected.provider, settings, environment);
    } else {
      const previous = writeManagedModelProviderCatalogSettings(
        selected.provider,
        settings,
        environment,
      );
      try {
        await writeConfigEdits(environment, [
          { keyPath: "model", value: model },
          { keyPath: "model_reasoning_effort", value: null },
          { keyPath: "model_context_window", value: null },
          { keyPath: "model_auto_compact_token_limit", value: null },
          { keyPath: "model_auto_compact_token_limit_scope", value: null },
        ]);
      } catch (error) {
        try {
          writeManagedModelProviderCatalogSettings(selected.provider, previous, environment);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "第三方模型设置失败，且未能恢复模型目录",
            { cause: rollbackError },
          );
        }
        throw error;
      }
    }
    output.write(`${selected.displayName} 默认模型已设为 ${model}。\n`);
    output.write(`模型上下文：${selectedModel.contextWindow} tokens。\n`);
    output.write(`默认思考等级：${reasoningEffort}。\n`);
    output.write(`自动压缩阈值：${autoCompactPercent}%（约 ${settings.autoCompactLimit} tokens）。\n`);
    output.write("新会话使用该默认值；恢复历史会话仍使用 Thread 原有模型。\n");
    output.write("请重启 App Server：codexc service restart app-server\n");
    return {
      action: "configured",
      provider: selected.provider,
      model,
      reasoningEffort,
      autoCompactPercent,
      mode: selected.mode,
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
    selectAutoCompactPercent: async (_provider, model) => {
      const current = model.autoCompactPercent ?? 90;
      const value = await prompts.text({
        message: `${model.displayName} 自动压缩百分比（10-90）`,
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
    throw new ModelProviderDefaultSetupCancelled("第三方模型设置已取消");
  }
  return value;
}
