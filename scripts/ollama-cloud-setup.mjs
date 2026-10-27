import * as clackPrompts from "@clack/prompts";
import { runProviderModelSetup } from "./provider-model-setup.mjs";
import { loadOllamaCloudAccounts, ollamaCloudProviderId } from "../runtime/ollama-cloud-accounts.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { ollamaCloudProviderDefinition as definition } from "../runtime/model-provider-definitions.mjs";
import { promptManagedAccountId, promptManagedAccountEdit, confirmManagedAccountEdit } from "./managed-provider-account-prompt.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  applyOllamaCloudConfiguration,
  previewOllamaCloudConfiguration,
  previewOllamaCloudRemoval,
  removeOllamaCloudConfiguration,
  setOllamaCloudDefaultAccount,
  previewOllamaCloudDefaultAccount,
  loadOllamaCloudModelChoices,
  discoverOllamaCloudAccountModels,
} from "./ollama-cloud-account-management.mjs";

export async function runOllamaCloudSetup(options = {}) {
  while (true) {
    const result = await runOllamaCloudSetupOperation(options);
    if (result.action === "menu-back") return { action: "back" };
    if (result.action === "back" && options.action === undefined) continue;
    return result;
  }
}

async function runOllamaCloudSetupOperation(options) {
  const { environment = process.env, prompts = clackPrompts, output = process.stdout, action: requestedAction, accountId: requestedId } = options;
  const accounts = loadOllamaCloudAccounts(environment);
  const action = requestedAction ?? await prompts.select({ message: "Ollama Cloud", options: [
    { value: "add", label: "添加账户" },
    ...(accounts.length ? [
      { value: "reconfigure", label: "编辑账户", hint: "API Key 与运行模式" },
      { value: "models", label: "模型管理", hint: "所有 Ollama Cloud 账户共用目录；默认模型按账户设置" },
      { value: "default", label: "设置默认账户", hint: "用于渠道默认选择，已有会话保持原账户" },
      { value: "remove", label: "移除本地账户配置" },
    ] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "menu-back" };
  if (!["add", "reconfigure", "models", "default", "remove"].includes(action)) throw new Error("未知 Ollama Cloud 账户操作");
  if (action === "models") return runProviderModelSetup({ environment, prompts, output, provider: "olc" });
  const accountId = requestedId ?? (action === "add"
    ? await promptManagedAccountId(prompts, accounts)
    : await prompts.select({ message: "选择账户", options: accounts.map(account => ({ value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}` })) }));
  if (prompts.isCancel(accountId)) return { action: "back" };
  let result;
  if (action === "remove") {
    const preview = await previewOllamaCloudRemoval(accountId, options);
    if (await prompts.confirm({ message: `确认移除 Ollama Cloud 账户 ${accountId} 的本地配置？将停止对应实例，该账户历史会话将不可用；保留共享模型目录、备份和历史统计。${preview.effects.restoresInitialConfig ? "将恢复该账户接管的主配置字段，保留其他设置。" : ""}`, initialValue: false }) !== true) return { action: "back" };
    result = await removeOllamaCloudConfiguration({ accountId, confirmRemove: true, expectedRevision: preview.revision }, options);
  } else if (action === "default") {
    const preview = previewOllamaCloudDefaultAccount(accountId, { environment });
    if (preview.willChange && await prompts.confirm({ message: `确认将 ${accountId} 设为默认账户？已有会话保持原账户。`, initialValue: false }) !== true) return { action: "back" };
    result = await setOllamaCloudDefaultAccount(accountId, { environment, signal: options.signal, expectedRevision: preview.revision });
  } else {
    const current = loadManagedModelProviderSettings(environment).find(entry => entry.provider === ollamaCloudProviderId(accountId));
    const edit = await promptManagedAccountEdit({ prompts, current, definition, reconfigure: action === "reconfigure" });
    if (!edit) return { action: "back" };
    const choices = loadOllamaCloudModelChoices(environment);
    let model = current?.model;
    let discovery;
    if (action === "add") {
      if (!choices.catalogExists) {
        output.write("正在读取 Ollama Cloud 公开模型与能力元数据（一小时内复用缓存）；不发送推理请求。\n");
        discovery = await discoverOllamaCloudAccountModels({ accountId, apiKey: edit.apiKey }, options);
        output.write(`${discovery.cache.hit ? "使用本地缓存" : "已刷新公开缓存"}；获取 ${discovery.cache.fetchedAt}；有效至 ${discovery.cache.expiresAt}。可用 codexc provider ollama-cloud discover --refresh 强制刷新。\n`);
        for (const entry of discovery.unavailableModels) output.write(`${JSON.stringify(entry.id)}：${entry.reason}\n`);
        if (!discovery.models.length) throw new Error("远端没有能力完整的可选模型，请稍后重新发现");
      }
      const models = discovery?.models ?? choices.models;
      model = await prompts.select({ message: "账户默认模型", options: models.map(entry => ({ value: entry.id, label: `${entry.name}（${entry.id}）`,
        ...(entry.contextWindow === undefined ? {} : { hint: discoveredModelSummary(entry) }),
      })) });
      if (prompts.isCancel(model)) return { action: "back" };
    }
    const input = { accountId, ...edit, ...(action === "add" ? { model } : {}), ...(discovery ? { discoveryToken: discovery.discoveryToken } : {}), reconfigure: action === "reconfigure" };
    output.write("新增或更换 Key 时，预览及保存会读取 Ollama Cloud 认证接口；不发送推理请求。\n");
    const preview = await previewOllamaCloudConfiguration(input, options);
    if (preview.initialModels) {
      output.write(`将创建所有 OLC 账户共用的受管模型目录：\n${preview.initialModels.map(entry => `  ${entry.name}（${entry.id}）\n  ${discoveredModelSummary(entry)}`).join("\n")}\n受管配置不代表真实云端推理已验收。\n`);
    }
    if (!await confirmManagedAccountEdit(preview, { prompts, output })) return { action: "back" };
    result = await applyOllamaCloudConfiguration({ ...input, confirmExclusiveConfigChange: preview.effects.writesMainConfig, expectedRevision: preview.revision }, options);
    if (result.action === "back") return result;
    output.write(result.action === "unchanged" ? "账户配置未变化，无需保存或重启。\n" : `Ollama Cloud 账户 ${accountId} 配置已保存。\n`);
    output.write("首次使用前，请在 codexc config → 提供商联网搜索中明确选择实时（live）或关闭（disabled）；固定模式按该入口提示修改全局设置。目录能力不决定搜索模式，跟随全局得到 cached/indexed 时会拒绝模型请求。\n");
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

function discoveredModelSummary(model) {
  const reasoning = model.reasoningMode === "toggle"
    ? `思考开关 ${model.reasoningEfforts.map(effort => effort === "none" ? "none=关闭" : "high=开启（非强度）").join("/")}`
    : `思考 ${model.reasoningEfforts.join("/")}`;
  return `窗口 ${model.contextWindow}（远端 ${model.upstreamContextWindow}）；${reasoning}（默认 ${model.defaultReasoningEffort}）；${model.supportsImages ? "支持图片" : "仅文本"}；freeform 与 tool_search 已启用`;
}
