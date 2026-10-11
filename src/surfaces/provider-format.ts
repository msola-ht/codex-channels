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
import { deepseekAccountIdFromProvider } from "../../runtime/deepseek-accounts.mjs";
import { clinePassAccountIdFromProvider } from "../../runtime/cline-pass-accounts.mjs";
import { ccgAccountIdFromProvider } from "../../runtime/ccg-accounts.mjs";
import { ccgAccountDefinition, clinePassAccountDefinition, deepseekAccountDefinition } from "../../runtime/model-provider-definitions.mjs";
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
  // 渠道统一使用短标签；模型目录定义的全名（*AccountDefinition）由模型列表按同一标签归一。
  const deepseekAccount = deepseekAccountIdFromProvider(provider);
  if (deepseekAccount !== undefined) return `DS ${deepseekAccount}`;
  const clinePassAccount = clinePassAccountIdFromProvider(provider);
  if (clinePassAccount !== undefined) return `CLP ${clinePassAccount}`;
  const commandCodeAccount = ccgAccountIdFromProvider(provider);
  if (commandCodeAccount !== undefined) return `CommandCode Go ${commandCodeAccount}`;
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

export interface ModelListEntry {
  /** 渠道列表项：`提供商 · 模型名`。 */
  name: string;
  /** 只有模型名（显示组名或去掉提供商前缀的目录名），供已单独展示提供商的位置使用。 */
  modelName: string;
  /** 模型名来自显示组映射，调用方不要再用原始 ID 补充。 */
  grouped: boolean;
}

/**
 * 渠道模型项统一为“提供商 · 模型名”。显示组名优先。
 * 受管账户目录自带的前缀按渠道标签归一（`Cline Pass main · ` → `CLP main · `）；
 * 聚合目录改显示成员提供商标签与模型名（成员模型名套用显示组），自定义目录已有的限定
 * 前缀保持原样，官方主 Provider 沿用模型自身的展示名。
 */
export function modelListEntry(
  displayName: string,
  provider: string | undefined,
  model = displayName,
): ModelListEntry {
  const aliased = Object.hasOwn(modelDisplayAliases, model);
  if (provider === "codexc-aggregate") {
    const member = aggregateMemberDisplay(displayName, model);
    if (member !== undefined) {
      // 完整聚合 ID 的显示组优先；未配置时沿用成员模型自己的显示组。
      const memberAliased = Object.hasOwn(modelDisplayAliases, member.model);
      const grouped = aliased || memberAliased;
      const memberName = grouped
        ? formatModelDisplayName(aliased ? model : member.model)
        : member.name;
      return { name: `${formatProviderLabel(member.provider)} · ${memberName}`, modelName: memberName, grouped };
    }
  }
  // 显示组名代替模型名，名称里不会再出现原始 ID。
  const name = aliased ? formatModelDisplayName(model) : displayName;
  // 官方主 Provider 的目录展示名不带提供商前缀，沿用原有显示。
  if (provider === undefined || provider === "openai") return { name, modelName: name, grouped: aliased };
  const label = formatProviderLabel(provider);
  // 显示组名不可能带提供商前缀，按来源直接补齐。
  if (aliased) return { name: `${label} · ${name}`, modelName: name, grouped: true };
  const catalogLabel = providerCatalogLabel(provider);
  // 目录尚未确认时占位模型的展示名就是提供商本身，不再叠加前缀。
  if (name === label || name === catalogLabel || name === provider) {
    return { name: label, modelName: label, grouped: false };
  }
  const scoped = stripProviderPrefix(name, [catalogLabel, label, provider]);
  return {
    name: scoped.includes(" · ") ? scoped : `${label} · ${scoped}`,
    modelName: scoped,
    grouped: false,
  };
}

/** 渠道选项与按钮文案：在名称前保留选择编号，防止同一提供商内多个模型映射同名后无法区分。 */
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
  const prefix = `${formatProviderLabel("codexc-aggregate")} · ${provider} · `;
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
  return undefined;
}

/** 渠道按短标签展示受管账户 Provider；其余位置保持原始标识。 */
export function formatDisplayedProvider(provider: string): string {
  return isManagedAccountProvider(provider) ? formatCodexProviderLabel(provider) : provider;
}

function isManagedAccountProvider(provider: string): boolean {
  return isOpencodeGoProvider(provider)
    || deepseekAccountIdFromProvider(provider) !== undefined
    || clinePassAccountIdFromProvider(provider) !== undefined
    || ccgAccountIdFromProvider(provider) !== undefined;
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
