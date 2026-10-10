import {
  fastServiceTierId,
  isFastServiceTier,
  ultrafastServiceTierId,
  type ModelOption,
} from "../application/index.js";
import {
  isOpencodeGoProvider,
  opencodeGoProviderDisplayName,
} from "../../runtime/opencode-go-accounts.mjs";
import { modelDisplayName } from "../../runtime/model-display-name.mjs";

let configuredCustomPrimaryProviderIds = new Set<string>();
let modelDisplayAliases: Readonly<Record<string, string>> = {};

export function setModelDisplayAliases(aliases: Readonly<Record<string, string>> = {}): void {
  modelDisplayAliases = { ...aliases };
}

export function formatModelDisplayName(model: string, fallback = model): string {
  return modelDisplayName(model, modelDisplayAliases, fallback);
}

export function formatModelDisplayNameWithId(model: string): string {
  const name = formatModelDisplayName(model);
  return name === model ? model : `${name}（${model}）`;
}

export function setConfiguredCustomPrimaryProviderId(
  providerId: string | readonly string[] | undefined,
): void {
  configuredCustomPrimaryProviderIds = new Set(
    providerId === undefined ? [] : typeof providerId === "string" ? [providerId] : providerId,
  );
}

export function formatProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "codexc-aggregate") return "聚合提供商";
  if (provider === "deepseek") return "DeepSeek";
  if (isOpencodeGoProvider(provider)) {
    return boundProviderLabel(opencodeGoProviderDisplayName(provider));
  }
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
    : configuredCustomPrimaryProviderIds.has(provider)
      ? `${formatProviderLabel(provider)} · 自定义`
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

export function scopedModelDisplayName(
  displayName: string,
  provider: string | undefined,
  model = displayName,
  selectionNumber?: number,
): string {
  if (Object.hasOwn(modelDisplayAliases, model)) {
    // 保留选择编号，防止相同显示组及平台截断隐藏原始 ID 后无法区分选项。
    return `${selectionNumber === undefined ? "" : `${selectionNumber}. `}${formatModelDisplayNameWithId(model)}`;
  }
  let scopedName = displayName;
  // 受管 Provider 的展示名会带上 definition.displayName 前缀（对 OpenCode Go 是
  // 账户邮箱），而 providerFilter 是原始 provider id（如 ocg-<accountId>），两者不同。
  // 优先按格式化后的提供商标签剥离，其次回退到原始 id，避免已单独展示 Provider 的卡片里重复前缀。
  if (provider) {
    for (const label of [formatProviderLabel(provider), provider]) {
      const prefix = `${label} · `;
      if (scopedName.startsWith(prefix)) {
        scopedName = scopedName.slice(prefix.length);
        break;
      }
    }
  }
  return scopedName;
}

export function formatDisplayedProvider(provider: string): string {
  return provider.startsWith("ocg-") ? formatCodexProviderLabel(provider) : provider;
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
