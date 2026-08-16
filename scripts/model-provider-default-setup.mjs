import * as clackPrompts from "@clack/prompts";

import {
  loadManagedModelProviderSettings,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";
import { writeCodexUserConfigEdits } from "./codex-user-config.mjs";

class ModelProviderDefaultSetupCancelled extends Error {}

export async function runModelProviderDefaultSetup({
  allowBack = false,
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
    const provider = await prompt.selectProvider();
    if (provider === "back") return { action: "back" };
    const selected = configured.find((candidate) => candidate.provider === provider);
    if (!selected) throw new Error(`第三方 Provider 未配置：${provider}`);
    const model = await prompt.selectModel(selected);
    if (!selected.models.includes(model)) {
      throw new Error(`${selected.displayName} 不支持模型：${model}`);
    }
    if (selected.mode === "switching") {
      writeManagedModelProviderProfileDefault(selected.provider, model, environment);
    } else {
      await writeConfigEdits(environment, [{ keyPath: "model", value: model }]);
    }
    output.write(`${selected.displayName} 默认模型已设为 ${model}。\n`);
    output.write("新会话使用该默认值；恢复历史会话仍使用 Thread 原有模型。\n");
    output.write("请重启 App Server：codexc service restart app-server\n");
    return {
      action: "configured",
      provider: selected.provider,
      model,
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
          value: model,
          label: model,
          ...(model === provider.model ? { hint: "当前" } : {}),
        })),
      });
      return requirePromptValue(prompts, value);
    },
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new ModelProviderDefaultSetupCancelled("第三方默认模型设置已取消");
  }
  return value;
}
