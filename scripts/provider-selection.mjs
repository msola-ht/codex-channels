import { aggregateProviderId } from "../runtime/aggregate-model-provider.mjs";
import { loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadPrimaryModelProvider,
} from "../runtime/model-provider-runtime.mjs";

/** Public selectors are exact registry identities, never prefix-stripped guesses. */
export function resolveProviderSelection(value, {
  environment = process.env,
  primaryProvider = loadPrimaryModelProvider(environment),
  customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider(environment),
  managedProfileDefinitions = loadManagedModelProviderDefinitions(environment),
  customSwitchingProfiles = loadConfiguredCustomSwitchingModelProviders(environment)
    .map(({ provider, profileName }) => ({ providerId: provider, profileName })),
} = {}) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("-p / --provider 必须指定 Provider ID、已配置的 sf- 名称或 agg");
  }
  const profiles = [
    ...managedProfileDefinitions.map(({ id, profileName }) => ({ provider: id, profileName })),
    ...customSwitchingProfiles.map(({ providerId, profileName }) => ({ provider: providerId, profileName })),
  ];
  if (value === aggregateProviderId) throw new Error("聚合选择请使用 agg 或 sf-agg");
  if (value === "agg" || value === "sf-agg") {
    if (profiles.some(({ provider, profileName }) => ["agg", "sf-agg"].includes(provider) || ["agg", "sf-agg"].includes(profileName))
      || ["agg", "sf-agg"].includes(primaryProvider) || ["agg", "sf-agg"].includes(customPrimaryProvider?.id)) {
      throw new Error(`${value} 与已配置提供商重名，无法选择聚合；请选择该提供商的规范 sf- 名称`);
    }
    return { provider: aggregateProviderId };
  }
  const matches = profiles.filter(({ provider, profileName }) => value === provider || value === profileName);
  const primary = value === primaryProvider || value === customPrimaryProvider?.id;
  const identities = new Set(matches.map(({ provider }) => provider));
  if (primary) identities.add(primaryProvider);
  if (identities.size > 1) throw new Error(`提供商选择 ${value} 有歧义，请使用无冲突的完整 Provider ID`);
  if (primary || identities.size === 1 && identities.has(primaryProvider)) return { provider: primaryProvider };
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`提供商选择 ${value} 重复，请检查提供商配置`);
  throw new Error(`提供商 ${value} 未配置；请使用完整 Provider ID 或已配置的规范 sf- 名称`);
}
