import {
  fastServiceTierId,
  isFastServiceTier,
  ultrafastServiceTierId,
  type ModelOption,
} from "../application/index.js";
import {
  opencodeGoAccountIdFromProvider,
  opencodeGoProviderDisplayName,
} from "../../runtime/opencode-go-accounts.mjs";
import { deepseekAccountIdFromProvider } from "../../runtime/deepseek-accounts.mjs";
import { clinePassAccountIdFromProvider } from "../../runtime/cline-pass-accounts.mjs";
import { ccgAccountIdFromProvider } from "../../runtime/ccg-accounts.mjs";
import { ccgAccountDefinition, clinePassAccountDefinition, deepseekAccountDefinition } from "../../runtime/model-provider-definitions.mjs";

export function formatProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "codexc-aggregate") return "AGG";
  if (provider === "deepseek") return "DeepSeek";
  // 渠道统一使用短标签；模型目录定义的全名（*AccountDefinition）由模型列表按同一标签归一。
  const deepseekAccount = deepseekAccountIdFromProvider(provider);
  if (deepseekAccount !== undefined) return `DS ${deepseekAccount}`;
  const clinePassAccount = clinePassAccountIdFromProvider(provider);
  if (clinePassAccount !== undefined) return `CLP ${clinePassAccount}`;
  const commandCodeAccount = ccgAccountIdFromProvider(provider);
  if (commandCodeAccount !== undefined) return `CCG ${commandCodeAccount}`;
  const opencodeAccount = opencodeGoAccountIdFromProvider(provider);
  if (opencodeAccount !== undefined) return `OCG ${opencodeAccount}`;
  if (/^cp-[A-Za-z0-9_-]{1,61}$/u.test(provider)) return `CP ${provider.slice(3)}`;
  const normalized = provider.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 64) : "未知提供商";
}

function boundProviderLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 64
    ? normalized
    : `${characters.slice(0, 61).join("")}...`;
}

export function formatCodexProviderLabel(provider?: string): string {
  return provider === undefined || provider === "openai"
    ? "OpenAI 官方"
    : formatProviderLabel(provider);
}

export function formatServiceTier(serviceTier: string | null | undefined, model?: ModelOption): string {
  if (serviceTier === "ultrafast") return "Ultrafast";
  if (isFastServiceTier(serviceTier ?? null, model)) return "Fast";
  if (serviceTier == null || serviceTier === "default") return "Standard";
  return `未知档位（${boundProviderLabel(serviceTier)}）`;
}

export function formatModelSpeedSupport(model: ModelOption | undefined): string {
  if (!model) return "支持情况未知";
  const speeds = [
    ...(fastServiceTierId(model) ? ["Fast"] : []),
    ...(ultrafastServiceTierId(model) ? ["Ultrafast"] : []),
  ];
  return speeds.length > 0 ? `支持 ${speeds.join("、")}` : "不支持加速档位";
}

export interface ModelListEntry {
  /** 渠道列表项：`提供商 · 模型名`。 */
  name: string;
  /** 去掉提供商前缀的原目录名称，供已单独展示提供商的位置使用。 */
  modelName: string;
}

/**
 * 渠道模型项统一为“提供商 · 原目录模型名”，统计分组不参与展示。
 * 受管账户目录自带的前缀按渠道标签归一（`Cline Pass main · ` → `CLP main · `）；
 * 聚合目录改显示成员提供商标签与原模型名，自定义目录已有的限定
 * 前缀保持原样，官方主 Provider 沿用模型自身的展示名。
 */
export function modelListEntry(
  displayName: string,
  provider: string | undefined,
  model = displayName,
): ModelListEntry {
  if (provider === "codexc-aggregate") {
    const member = aggregateMemberDisplay(displayName, model);
    if (member !== undefined) {
      return { name: `${formatProviderLabel(member.provider)} · ${member.name}`, modelName: member.name };
    }
  }
  const name = displayName;
  // 官方主 Provider 的目录展示名不带提供商前缀，沿用原有显示。
  if (provider === undefined || provider === "openai") return { name, modelName: name };
  const label = formatProviderLabel(provider);
  const catalogLabel = providerCatalogLabel(provider);
  // 目录尚未确认时占位模型的展示名就是提供商本身，不再叠加前缀。
  if (name === label || name === catalogLabel || name === provider) {
    return { name: label, modelName: label };
  }
  const scoped = stripProviderPrefix(name, [catalogLabel, label, provider]);
  return {
    name: scoped.includes(" · ") ? scoped : `${label} · ${scoped}`,
    modelName: scoped,
  };
}

/** 渠道选项与按钮文案：保留原目录模型名和选择编号。 */
export function modelListDisplayName(
  displayName: string,
  provider: string | undefined,
  model = displayName,
  selectionNumber?: number,
): string {
  const { name } = modelListEntry(displayName, provider, model);
  return `${selectionNumber === undefined ? "" : `${selectionNumber}. `}${name}`;
}

/**
 * 聚合模型 ID 是 `${成员Provider}/${成员模型ID}`，目录展示名是
 * `聚合提供商 · <成员Provider> · <成员模型名>`；拆出成员侧供渠道显示。
 */
function aggregateMemberDisplay(
  displayName: string,
  model: string,
): { provider: string; model: string; name: string } | undefined {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  const provider = model.slice(0, separator);
  // 目录来源使用固定名称，与渠道短标签 AGG 分离。
  const prefix = `聚合提供商 · ${provider} · `;
  if (!displayName.startsWith(prefix)) return undefined;
  return { provider, model: model.slice(separator + 1), name: displayName.slice(prefix.length) };
}

/** 只剥离已知来源的 `${提供商} · ` 前缀，不按内容猜测。 */
function stripProviderPrefix(name: string, labels: readonly (string | undefined)[]): string {
  for (const label of labels) {
    if (label === undefined) continue;
    const prefix = `${label} · `;
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/** 受管账户模型目录使用的展示名前缀，来自 Runtime 的账户定义。 */
function providerCatalogLabel(provider: string): string | undefined {
  const deepseekAccount = deepseekAccountIdFromProvider(provider);
  if (deepseekAccount !== undefined) return deepseekAccountDefinition(deepseekAccount).displayName;
  const clinePassAccount = clinePassAccountIdFromProvider(provider);
  if (clinePassAccount !== undefined) return clinePassAccountDefinition(clinePassAccount).displayName;
  const commandCodeAccount = ccgAccountIdFromProvider(provider);
  if (commandCodeAccount !== undefined) return ccgAccountDefinition(commandCodeAccount).displayName;
  if (opencodeGoAccountIdFromProvider(provider) !== undefined) return opencodeGoProviderDisplayName(provider);
  return undefined;
}

/** 会话、模型行和定时任务复用渠道短标签；官方标识保持原有展示。 */
export function formatDisplayedProvider(provider: string): string {
  return provider === "openai" ? provider : formatProviderLabel(provider);
}

/** 不改变目录排序或选择编号；不可用模型仍保留在原目录中。 */
export function formatProviderModelSummary(models: readonly ModelOption[], provider: string): string {
  let available = 0;
  let unavailable = 0;
  for (const model of models) {
    if ((model.provider ?? "openai") !== provider) continue;
    if (model.available === false) unavailable += 1;
    else available += 1;
  }
  if (available === 0) return `暂不可用（共 ${unavailable} 个模型）`;
  return unavailable === 0 ? `${available} 个模型`
    : `${available} 个可用模型 · ${unavailable} 个暂不可用模型`;
}
