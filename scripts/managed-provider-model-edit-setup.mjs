import * as clackPrompts from "@clack/prompts";
import { loadProviderModelCatalogs } from "./provider-model-management.mjs";
import { loadManagedProviderModelEdit, previewManagedProviderModelEdit, applyManagedProviderModelEdit } from "./managed-provider-model-edit.mjs";
import { promptResponsesModels } from "./responses-model-setup.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";

export async function runManagedProviderModelEditSetup(provider, {
  environment = process.env, prompts = clackPrompts, output = process.stdout,
} = {}) {
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const catalog = catalogs.find(entry => entry.providers.includes(provider));
  if (!catalog || !catalog.provider.startsWith("clp-")) throw new Error("本地模型编辑请选择已配置的 CLP 账户");
  const model = await prompts.select({
    message: "选择要本地编辑的 CLP 模型",
    options: catalog.models.map(entry => ({ value: entry.id, label: `${entry.displayName}（${entry.id}）` })),
  });
  if (prompts.isCancel(model)) return { action: "back", activation: "none" };
  const current = await loadManagedProviderModelEdit(provider, model, { environment });
  output.write(`直接编辑已保存配置，不下载模板；模型 ID、请求格式和来源关联保持不变。\n影响账户：${current.providers.join("、")}。\n`);
  const definitions = await promptResponsesModels(prompts, model, [current.definition], output,
    "chat_completions", [model], { allowAdd: false, managedClinePass: true });
  if (definitions === undefined) return { action: "back", activation: "none" };
  const input = { provider, model, revision: current.revision, definition: definitions[0] };
  const preview = await previewManagedProviderModelEdit(input, { environment });
  if (!preview.willChange) {
    output.write("模型配置未变化，无需保存或重启。\n");
    return { action: "unchanged", activation: "none" };
  }
  output.write(`模型 ID：${JSON.stringify(model)}（保持不变）\n影响账户：${preview.providers.join("、")}\n`);
  for (const change of preview.changes) {
    output.write(`${change.field}：\n  修改前：${change.before.present ? JSON.stringify(change.before.value) : "未设置"}\n  修改后：${change.after.present ? JSON.stringify(change.after.value) : "未设置"}\n`);
  }
  if (await prompts.confirm({ message: "备份并保存本地模型修改？", initialValue: false }) !== true) {
    return { action: "back", activation: "none" };
  }
  const result = await applyManagedProviderModelEdit(input, { environment, preview });
  output.write("本地模型配置已保存并回读。\n");
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}
