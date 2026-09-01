import * as clackPrompts from "@clack/prompts";

import { loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import {
  loadCodexUserSettings,
  updateCodexUserSetting,
} from "./codex-user-settings-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export async function runCodexDefaultsSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  allowBack = false,
  createClient = createCodexUserConfigClient,
  primaryProvider = loadPrimaryModelProvider,
  loadSettings = loadCodexUserSettings,
  updateSetting = updateCodexUserSetting,
} = {}) {
  const settings = await loadSettings({ environment, createClient, primaryProvider });
  if (!settings.defaultsEditable) {
    throw new Error(
      `当前是第三方固定模式（${settings.provider}）；请先恢复 OpenAI 默认配置，再设置 Codex 官方模型`,
    );
  }
  const availableModels = settings.models;
  if (availableModels.length === 0) {
    throw new Error("Codex App Server 没有返回可用的官方模型");
  }
  const fallbackModel = availableModels.find((model) => model.model === settings.defaults.model)
    ?? availableModels.find((model) => model.isDefault)
    ?? availableModels[0];
  const selectedModel = await prompts.select({
    message: "选择 Codex 全局默认模型",
    showInstructions: false,
    initialValue: fallbackModel.model,
    options: [
      ...availableModels.map((model) => ({
        value: model.model,
        label: model.displayName,
        hint: model.model,
      })),
      ...(allowBack ? [{ value: "back", label: "返回", hint: "返回 Codex 新会话默认值" }] : []),
    ],
  });
  if (prompts.isCancel(selectedModel) || selectedModel === "back") {
    return { action: "back" };
  }
  const model = availableModels.find((candidate) => candidate.model === selectedModel);
  if (!model) {
    throw new Error("选择的 Codex 官方模型已经不可用");
  }
  if (model.reasoningEfforts.length === 0) {
    throw new Error(`Codex 模型没有返回可用思考等级：${model.model}`);
  }
  const currentEffort = model.model === settings.defaults.model
    && model.reasoningEfforts.some(
      (option) => option.effort === settings.defaults.reasoningEffort,
    )
    ? settings.defaults.reasoningEffort
    : model.defaultReasoningEffort;
  const selectedEffort = await prompts.select({
    message: `选择 ${model.displayName} 的全局默认思考等级`,
    showInstructions: false,
    initialValue: currentEffort,
    options: [
      ...model.reasoningEfforts.map((option) => ({
        value: option.effort,
        label: option.effort,
        hint: option.description,
      })),
      ...(allowBack ? [{ value: "back", label: "返回", hint: "返回 Codex 新会话默认值" }] : []),
    ],
  });
  if (prompts.isCancel(selectedEffort) || selectedEffort === "back") {
    return { action: "back" };
  }
  if (!model.reasoningEfforts.some((option) => option.effort === selectedEffort)) {
    throw new Error(`当前模型不支持该思考等级：${String(selectedEffort)}`);
  }
  const confirmed = await prompts.confirm({
    message: `保存 Codex 全局默认设置：${model.model} · ${selectedEffort}？`,
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改 Codex 全局配置。\n");
    return undefined;
  }
  await updateSetting({
    kind: "defaults",
    model: model.model,
    reasoningEffort: selectedEffort,
  }, {
    environment,
    expectedVersion: settings.version,
    createClient,
    primaryProvider,
  });
  output.write(`Codex 全局默认设置已更新：${model.model} · ${selectedEffort}\n`);
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  return {
    model: model.model,
    effort: selectedEffort,
    activation: "restart-all",
    activationResult: configActivationResult("restart-all"),
  };
}
