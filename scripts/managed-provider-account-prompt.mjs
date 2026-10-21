import { managedAccountIdPresets, newManagedAccountIdError } from "../runtime/managed-provider-account-options.mjs";
import { isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";

export async function promptManagedAccountEdit({ prompts, current, definition, reconfigure }) {
  const mode = await prompts.select({ message: "运行模式", initialValue: current?.mode ?? "switching", options: [
    { value: "switching", label: "切换模式", hint: "保留 OpenAI 主实例，使用独立实例" },
    { value: "exclusive", label: "固定模式", hint: "修改主实例配置，使用此账户" },
  ] });
  if (prompts.isCancel(mode)) return undefined;
  const apiKey = await prompts.password({
    message: `${definition.displayName} API Key${reconfigure ? "（留空保留当前 Key）" : ""}`,
    validate: (value = "") => reconfigure && value === "" || isManagedProviderApiKeyValid(definition, value) ? undefined : "请输入有效 API Key",
  });
  if (prompts.isCancel(apiKey)) return undefined;
  return { mode, ...(reconfigure && (apiKey === undefined || apiKey === "") ? {} : { apiKey }) };
}

export async function confirmManagedAccountEdit(preview, { prompts, output }) {
  if (!preview.willChange) return true;
  const modeLabel = mode => mode === "exclusive" ? "固定模式" : "切换模式";
  output.write(`账户：${preview.account.provider}\n运行模式：${preview.previousMode === undefined ? "未配置" : modeLabel(preview.previousMode)} → ${modeLabel(preview.mode)}\nAPI Key：${preview.credentialAction === "preserve" ? "保留当前 Key" : "写入新 Key"}\n`);
  if (preview.model !== undefined) output.write(`默认模型：${preview.model}\n`);
  if (preview.effects.writesMainConfig) output.write("此操作会修改或恢复该账户接管的 Codex 主配置字段。\n");
  return await prompts.confirm({ message: "确认保存上述账户配置？", initialValue: false }) === true;
}

export async function promptManagedAccountId(prompts, accounts, reservedIds = []) {
  const choice = await prompts.select({
    message: "新账户 ID",
    options: [...managedAccountIdPresets(accounts), { value: "custom", label: "自定义" }],
  });
  if (prompts.isCancel(choice)) return choice;
  if (choice !== "custom") return choice;
  return prompts.text({ message: "账户 ID", validate: value => newManagedAccountIdError(value, accounts, reservedIds) });
}
