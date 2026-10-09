import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
} from "./model-provider-runtime.mjs";
import { isDeepseekAccountProvider } from "./deepseek-accounts.mjs";
import { isClinePassAccountProvider } from "./cline-pass-accounts.mjs";

/** Classify validated Provider configuration and registered managed models. */
export function resolveAutoReviewProviderPolicy({
  primaryProvider,
  customPrimaryProvider,
  customSwitchingProviders,
  managedProviders = [],
}) {
  const officialPrimarySupported = primaryProvider === "openai"
    && customPrimaryProvider?.catalogPath === undefined;
  const supportedProviders = new Set();
  const supportedModels = new Map();
  const defaultModels = new Map();
  if (officialPrimarySupported) {
    // Fixed custom Providers share the primary routing key, but Threads retain
    // their actual Provider ID. A custom catalog must never inherit this alias.
    supportedProviders.add(primaryProvider);
    if (customPrimaryProvider) supportedProviders.add(customPrimaryProvider.id);
  }
  for (const provider of customSwitchingProviders) {
    if (provider.catalogSource.kind === "official") {
      supportedProviders.add(provider.provider);
    }
  }
  for (const provider of managedProviders) {
    // Only the registered managed settings establish DS/CLP ownership. Provider
    // names from custom configuration must not inherit managed capabilities.
    const verifiedModel = isDeepseekAccountProvider(provider.provider)
      ? "deepseek-flash"
      : isClinePassAccountProvider(provider.provider)
        ? "cline-pass/deepseek-v4.1-flash"
        : undefined;
    if (verifiedModel === undefined
      || !provider.models.some(({ model }) => model === verifiedModel)) continue;
    supportedProviders.add(provider.provider);
    supportedModels.set(provider.provider, new Set([verifiedModel]));
    defaultModels.set(provider.provider, provider.model);
  }
  const policy = { primarySupported: false, supportedProviders, supportedModels, defaultModels };
  policy.primarySupported = officialPrimarySupported
    || supportedModels.has(primaryProvider) && isAutoReviewModelSupported(policy, primaryProvider);
  return policy;
}

/** Official catalog Providers retain their original model-wide capability. */
export function isAutoReviewModelSupported(policy, provider, model) {
  if (!policy.supportedProviders.has(provider)) return false;
  const models = policy.supportedModels.get(provider);
  if (models === undefined) return true;
  const selectedModel = model ?? policy.defaultModels.get(provider);
  return selectedModel !== undefined && models.has(selectedModel);
}

export function loadAutoReviewProviderPolicy(environment = process.env) {
  return resolveAutoReviewProviderPolicy({
    primaryProvider: loadPrimaryModelProvider(environment),
    customPrimaryProvider: loadConfiguredCustomPrimaryModelProvider(environment),
    customSwitchingProviders: loadConfiguredCustomSwitchingModelProviders(environment),
    managedProviders: loadManagedModelProviderSettings(environment),
  });
}

/** Optional settings projection; runtime policy loading remains strict. */
export function autoReviewProviderCapability(environment, primaryOnly = false, loadPolicy = loadAutoReviewProviderPolicy) {
  try {
    const policy = loadPolicy(environment);
    return {
      canEnableAutoReview: primaryOnly ? policy.primarySupported : policy.supportedProviders.size > 0,
      autoReviewUnavailableReason: null,
    };
  } catch {
    return {
      canEnableAutoReview: false,
      autoReviewUnavailableReason: "provider-config-unavailable",
    };
  }
}
