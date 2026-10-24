import * as clackPrompts from "@clack/prompts";
import { loadProviderModelCatalogs } from "./provider-model-management.mjs";
import {
  loadManagedProviderModelEdit,
  previewManagedProviderModelRequestOptions,
  applyManagedProviderModelRequestOptions,
} from "./managed-provider-model-edit.mjs";
import { validateClinePassProviderOptions } from "../runtime/cline-provider-options.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";

export async function runClinePassRequestOptionsSetup(provider, {
  environment = process.env, prompts = clackPrompts, output = process.stdout,
} = {}) {
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const catalog = catalogs.find(entry => entry.providers.includes(provider));
  if (!catalog || !catalog.provider.startsWith("clp-")) throw new Error("请求改写编辑请选择已配置的 CLP 账户");
  const model = await prompts.select({
    message: "选择要编辑请求改写的 CLP 模型",
    options: catalog.models.map(entry => ({ value: entry.id, label: `${entry.displayName}（${entry.id}）` })),
  });
  if (prompts.isCancel(model)) return { action: "back", activation: "none" };
  const current = await loadManagedProviderModelEdit(provider, model, { environment });
  output.write(`模型：${model}\n影响账户：${current.providers.join("、")}\n`);
  output.write(`请求格式：${current.requestProfile === "deepseek-flash" ? "Flash 格式；未显式设置 gateway.only 时默认使用 deepseek" : "标准格式，由 Cline 选择上游"}。\n`);
  output.write("内容会原样合并到出站 providerOptions；字段不设白名单，格式或取值错误以上游返回为准。\n");
  output.write("只校验 JSON 对象、大小与嵌套深度，并拒绝凭据字段、gateway.byok 和原型污染键。\n");
  const value = await prompts.text({
    message: "providerOptions JSON（清除改为 {}）",
    initialValue: JSON.stringify(current.providerOptions),
    validate: text => {
      try {
        const parsed = JSON.parse(text);
        validateClinePassProviderOptions(parsed);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "请求改写无效";
      }
    },
  });
  if (prompts.isCancel(value)) return { action: "back", activation: "none" };
  let providerOptions;
  try {
    providerOptions = validateClinePassProviderOptions(JSON.parse(value)) ?? {};
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "请求改写无效", { cause: error });
  }
  const preview = await previewManagedProviderModelRequestOptions({
    provider, model, revision: current.revision, providerOptions,
  }, { environment });
  if (!preview.willChange) {
    output.write("请求改写未变化，无需保存或重启。\n");
    return { action: "unchanged", activation: "none" };
  }
  for (const change of preview.changes) {
    output.write(`${change.field}：\n  修改前：${change.before.present ? JSON.stringify(change.before.value) : "未设置"}\n  修改后：${change.after.present ? JSON.stringify(change.after.value) : "未设置"}\n`);
  }
  if (await prompts.confirm({ message: "备份并保存请求改写？", initialValue: false }) !== true) {
    return { action: "back", activation: "none" };
  }
  const result = await applyManagedProviderModelRequestOptions({
    provider, model, revision: current.revision, providerOptions,
  }, { environment, preview });
  output.write("请求改写已保存并回读。\n");
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}
