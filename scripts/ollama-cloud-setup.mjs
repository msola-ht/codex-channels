import * as clackPrompts from "@clack/prompts";
import { runProviderModelSetup } from "./provider-model-setup.mjs";
import { loadOllamaCloudAccounts, ollamaCloudProviderId } from "../runtime/ollama-cloud-accounts.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { ollamaCloudProviderDefinition as definition } from "../runtime/model-provider-definitions.mjs";
import { promptManagedAccountId, promptManagedAccountEdit, confirmManagedAccountEdit } from "./managed-provider-account-prompt.mjs";
import { defaultModelDisplayName } from "../runtime/model-catalog.mjs";
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
    let model;
    let initialModel;
    if (choices.catalogExists) {
      model = await prompts.select({ message: "账户默认模型（选择共享目录中的准确 ID）", initialValue: current?.model, options: choices.models.map(entry => ({ value: entry.id, label: `${entry.name}（${entry.id}）` })) });
      if (prompts.isCancel(model)) return { action: "back" };
    } else {
      initialModel = await promptInitialModel(prompts, output);
      if (!initialModel) return { action: "back" };
      model = initialModel.id;
    }
    const input = { accountId, ...edit, model, ...(initialModel ? { initialModel } : {}), reconfigure: action === "reconfigure" };
    output.write("新增或更换 Key 时，预览及保存会读取 Ollama Cloud 认证接口；不发送推理请求。首次手动模型仅声明能力，不证明上游已通过 Responses 验证。\n");
    const preview = await previewOllamaCloudConfiguration(input, options);
    if (preview.initialModel) {
      const model = preview.initialModel;
      output.write(`将创建所有 OLC 账户共用的模型目录（手动能力声明）\n准确 ID：${model.id}\n显示名称：${model.name}\n上下文：${model.contextWindow} Token\n支持思考等级：${model.reasoningEfforts.join(" / ")}\n默认思考等级：${model.defaultReasoningEffort}\n图片输入：${model.supportsImages ? "支持" : "不支持"}\nfreeform：${model.applyPatchToolType === "freeform" ? "声明支持" : "关闭"}；tool_search 与原生搜索关闭。\n`);
    }
    if (!await confirmManagedAccountEdit(preview, { prompts, output })) return { action: "back" };
    result = await applyOllamaCloudConfiguration({ ...input, confirmExclusiveConfigChange: preview.effects.writesMainConfig, expectedRevision: preview.revision }, options);
    if (result.action === "back") return result;
    output.write(result.action === "unchanged" ? "账户配置未变化，无需保存或重启。\n" : `Ollama Cloud 账户 ${accountId} 配置已保存。\n`);
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

async function promptInitialModel(prompts, output) {
  output.write("首次创建共享目录：填写准确模型和能力；freeform 需明确声明，tool_search 与原生搜索保持关闭。\n");
  const id = await prompts.text({ message: "准确模型 ID（保留版本与冒号）", validate: value => typeof value === "string" && value.trim() === value && value.length > 0 ? undefined : "请输入准确 ID" });
  if (prompts.isCancel(id)) return undefined;
  const name = await prompts.text({ message: "显示名称", initialValue: defaultModelDisplayName(id) });
  if (prompts.isCancel(name)) return undefined;
  const context = await prompts.text({ message: "上下文 Token 数（1024–100000000）", validate: value => Number.isSafeInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= 100000000 ? undefined : "请输入合法整数窗口" });
  if (prompts.isCancel(context)) return undefined;
  const reasoningEfforts = await prompts.multiselect({ message: "明确支持的思考等级（至少一个）", options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: value })), required: true });
  if (prompts.isCancel(reasoningEfforts)) return undefined;
  const defaultReasoningEffort = await prompts.select({ message: "默认思考等级", options: reasoningEfforts.map(value => ({ value, label: value })) });
  if (prompts.isCancel(defaultReasoningEffort)) return undefined;
  const supportsImages = await prompts.confirm({ message: "明确支持图片输入？", initialValue: false });
  if (prompts.isCancel(supportsImages)) return undefined;
  const supportsPatch = await prompts.confirm({ message: "明确支持 Codex 自由格式 apply_patch？（声明不等于真实上游验收）", initialValue: false });
  if (prompts.isCancel(supportsPatch)) return undefined;
  return { id, name, contextWindow: Number(context), reasoningEfforts, defaultReasoningEffort, supportsImages, applyPatchToolType: supportsPatch ? "freeform" : null, supportsSearchTool: false };
}
