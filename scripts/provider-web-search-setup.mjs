import * as clackPrompts from "@clack/prompts";
import { createHash } from "node:crypto";
import { loadModelProviderManagementState, loadProviderWebSearchSettings } from "./model-provider-management.mjs";
import { previewProviderWebSearchChange, applyProviderWebSearchChange, ProviderWebSearchManagementError } from "./provider-web-search-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

const modeLabels = { disabled: "关闭", cached: "缓存", indexed: "索引", live: "实时" };
const modeLabel = (mode, provider = "") => mode === null ? provider.startsWith("olc-") ? "默认关闭" : "跟随全局" : modeLabels[mode];

/** CLI and WebUI share the same provider selection, preview and file transaction. */
export async function runProviderWebSearchSettingsSetup({
  environment = process.env, prompts = clackPrompts, output = process.stdout,
} = {}) {
  try {
    const state = await loadModelProviderManagementState({ environment });
    const settings = loadProviderWebSearchSettings(state, environment);
    const provider = await prompts.select({
      message: "选择要修改联网搜索的提供商",
      options: [...settings.map(entry => ({ value: entry.provider, label: entry.provider,
        hint: entry.status === "error" ? "配置不可读取，不能修改"
          : entry.source === "global" ? "共用全局搜索设置"
            : `当前：${modeLabel(entry.mode, entry.provider)}` })), { value: "back", label: "返回" }],
    });
    if (prompts.isCancel(provider) || provider === "back") return { action: "back" };
    const selected = settings.find(entry => entry.provider === provider);
    if (!selected || selected.status !== "ready") {
      output.write("所选提供商的搜索配置不可安全读取，请检查配置后重试；未执行写入。\n");
      return { action: "back" };
    }
    if (provider.startsWith("olc-")) output.write("Ollama Cloud 搜索可能收费，未设置时默认关闭。切换账户不继承全局搜索；固定账户保留主配置的显式值。需搜索时请显式选择实时（live）；缓存和索引不受支持。\n");
    if (selected.source === "global") {
      output.write(`${provider} 共用主 config.toml 的全局搜索设置。\n请进入 codexc config → Codex 新会话与用户偏好 → 联网搜索模式；修改会影响所有跟随全局的提供商。\n`);
      return { action: "back" };
    }
    output.write(`当前全局搜索：${state.defaults.webSearch === null ? "未显式设置（使用 Codex 默认值）" : modeLabel(state.defaults.webSearch)}。\n`);
    if (provider.startsWith("clp-")) output.write("CLP 独立搜索需选择实时（live）；缓存和索引不受该适配支持。\n");
    const choice = await prompts.select({
      message: `选择 ${provider} 的联网搜索模式`,
      initialValue: selected.mode ?? "inherit",
      options: [{ value: "inherit", label: modeLabel(null, provider), hint: "删除此提供商 config 顶层的 web_search" },
        ...Object.entries(modeLabels).map(([value, label]) => ({ value, label })),
        { value: "back", label: "返回" }],
    });
    if (prompts.isCancel(choice) || choice === "back") return { action: "back" };
    if (choice !== "inherit" && !Object.hasOwn(modeLabels, choice)) {
      output.write("搜索模式选择无效，未执行写入。\n");
      return { action: "back" };
    }
    const input = { provider, mode: choice === "inherit" ? null : choice,
      resourceRevision: createHash("sha256").update(JSON.stringify({ state, settings })).digest("hex") };
    const preview = await previewProviderWebSearchChange(input, { environment });
    output.write(`提供商：${preview.provider}\n搜索模式：${modeLabel(preview.before.mode, provider)} → ${modeLabel(preview.mode, provider)}\n${preview.mode === null ? "删除" : "写入"}该提供商 config 顶层 web_search。\n`);
    if (!preview.willChange) {
      output.write("当前值未变化，未写入配置，无需重启服务。\n");
      return { ...preview, action: "unchanged" };
    }
    if (await prompts.confirm({ message: `确认保存 ${provider} 的联网搜索设置？`, initialValue: false }) !== true) {
      output.write("已取消，未修改联网搜索设置。\n");
      return { action: "back" };
    }
    const result = await applyProviderWebSearchChange(input, { environment, preview });
    output.write(`${provider} 联网搜索模式已保存并回读确认：${modeLabel(result.mode, provider)}。\n`);
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
    return result;
  } catch (error) {
    output.write(`${error instanceof ProviderWebSearchManagementError ? error.message : "提供商搜索设置操作未完成，请检查配置状态后重新进入；不要自动重试保存。"}\n`);
    return { action: "back" };
  }
}
