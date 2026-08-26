import * as clackPrompts from "@clack/prompts";

import {
  writeCliMessage,
  writeCliRemediationRestartAll,
} from "../runtime/cli-presentation.mjs";
import {
  loadCustomModelProviderRoleCandidates,
  loadManagedModelProviderSettings,
} from "../runtime/model-provider-runtime.mjs";
import {
  agentsStatus,
  configureThirdPartyRole,
  disableThirdPartyRole,
} from "./agents.mjs";

export async function runThirdPartyAgentSetup({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  loadProviders = loadThirdPartyAgentSetupProviders,
  loadStatus = agentsStatus,
  configureRole = configureThirdPartyRole,
  disableRole = disableThirdPartyRole,
} = {}) {
  const providers = loadProviders(environment);
  const status = loadStatus(environment);
  const managedRoleConfigured = status.externalRoleConfigured || status.legacyDsRoleConfigured;
  if (providers.length === 0 && !managedRoleConfigured) {
    output.write(
      "尚未配置可用于共享子代理的第三方 Provider；"
      + "请先配置自定义 Responses Provider、DeepSeek 或 OpenCode Go。\n",
    );
    return { action: "back" };
  }
  const action = await prompts.select({
    message: "共享第三方子代理",
    showInstructions: false,
    options: [
      ...(providers.length > 0
        ? [{
            value: "configure",
            label: managedRoleConfigured ? "修改 Provider 与模型" : "配置 Provider 与模型",
            hint: status.provider && status.model
              ? `当前：${status.provider} · ${status.model}`
              : "注册单次 agents.external 角色",
          }]
        : []),
      ...(managedRoleConfigured
        ? [{ value: "disable", label: "停用共享第三方子代理", hint: "移除本项目管理的 agents.external" }]
        : []),
      ...(allowBack ? [{ value: "back", label: "返回", hint: "返回第三方 Provider 设置" }] : []),
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "disable") {
    const confirmed = await prompts.confirm({
      message: "确认停用本项目管理的共享第三方子代理？",
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) return { action: "back" };
    const removed = await disableRole(environment);
    if (removed) {
      writeCliMessage("success", "已移除共享第三方子代理。", {
        stdout: output,
        environment,
      });
      writeCliRemediationRestartAll({ stdout: output, environment });
    } else {
      writeCliMessage("note", "当前没有本项目管理的第三方子代理，无需处理。", {
        stdout: output,
        environment,
      });
    }
    return { action: "disabled" };
  }
  if (action !== "configure") throw new Error(`未知第三方子代理操作：${String(action)}`);

  const provider = await prompts.select({
    message: "选择共享子代理 Provider",
    showInstructions: false,
    initialValue: status.provider,
    options: [
      ...providers.map((candidate) => ({
        value: candidate.provider,
        label: candidate.displayName,
        hint: candidate.provider === status.provider ? "当前选择" : `默认模型：${candidate.model}`,
      })),
      ...(allowBack ? [{ value: "back", label: "返回", hint: "返回第三方 Provider 设置" }] : []),
    ],
  });
  if (prompts.isCancel(provider) || provider === "back") return { action: "back" };
  const selectedProvider = providers.find((candidate) => candidate.provider === provider);
  if (!selectedProvider) throw new Error(`第三方 Provider 未配置：${String(provider)}`);
  const model = await prompts.select({
    message: `选择 ${selectedProvider.displayName} 子代理模型`,
    showInstructions: false,
    initialValue: selectedProvider.provider === status.provider
      ? status.model
      : selectedProvider.model,
    options: [
      ...selectedProvider.models.map((candidate) => ({
        value: candidate.model,
        label: candidate.displayName,
        ...(candidate.model === status.model && selectedProvider.provider === status.provider
          ? { hint: "当前选择" }
          : {}),
      })),
      ...(allowBack ? [{ value: "back", label: "返回", hint: "返回第三方 Provider 设置" }] : []),
    ],
  });
  if (prompts.isCancel(model) || model === "back") return { action: "back" };
  if (!selectedProvider.models.some((candidate) => candidate.model === model)) {
    throw new Error(`${selectedProvider.displayName} 不支持模型：${String(model)}`);
  }
  const selection = await configureRole(provider, model, environment);
  writeCliMessage(
    "success",
    `已配置共享第三方子代理：${selection.provider} / ${selection.model}（agents.external）。`,
    { stdout: output, environment },
  );
  writeCliRemediationRestartAll({ stdout: output, environment });
  return { action: "configured", provider: selection.provider, model: selection.model };
}

export function loadThirdPartyAgentSetupProviders(environment = process.env) {
  return [
    ...loadManagedModelProviderSettings(environment),
    ...loadCustomModelProviderRoleCandidates(environment).map((provider) => ({
      provider: provider.provider,
      displayName: provider.displayName,
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
      mode: provider.mode,
      models: [{
        model: provider.model,
        displayName: provider.model,
        contextWindow: 0,
        reasoningEffort: provider.reasoningEffort,
        reasoningEfforts: [],
      }],
    })),
  ];
}
