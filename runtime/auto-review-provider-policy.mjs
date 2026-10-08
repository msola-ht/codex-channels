import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadPrimaryModelProvider,
} from "./model-provider-runtime.mjs";

/** Classify validated Provider configuration by its model catalog source. */
export function resolveAutoReviewProviderPolicy({
  primaryProvider,
  customPrimaryProvider,
  customSwitchingProviders,
}) {
  const primarySupported = primaryProvider === "openai"
    && customPrimaryProvider?.catalogPath === undefined;
  const supportedProviders = new Set();
  if (primarySupported) {
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
  return { primarySupported, supportedProviders };
}

export function loadAutoReviewProviderPolicy(environment = process.env) {
  return resolveAutoReviewProviderPolicy({
    primaryProvider: loadPrimaryModelProvider(environment),
    customPrimaryProvider: loadConfiguredCustomPrimaryModelProvider(environment),
    customSwitchingProviders: loadConfiguredCustomSwitchingModelProviders(environment),
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
