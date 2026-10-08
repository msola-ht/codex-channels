export interface AutoReviewProviderPolicy {
  primarySupported: boolean;
  supportedProviders: ReadonlySet<string>;
}

export function resolveAutoReviewProviderPolicy(options: {
  primaryProvider: string;
  customPrimaryProvider?: { id: string; catalogPath?: string } | undefined;
  customSwitchingProviders: readonly {
    provider: string;
    catalogSource: { kind: "official" } | { kind: "custom"; path: string };
  }[];
}): AutoReviewProviderPolicy;

export function loadAutoReviewProviderPolicy(
  environment?: NodeJS.ProcessEnv,
): AutoReviewProviderPolicy;

export interface AutoReviewProviderCapability {
  canEnableAutoReview: boolean;
  autoReviewUnavailableReason: "provider-config-unavailable" | null;
}
export function autoReviewProviderCapability(
  environment: NodeJS.ProcessEnv,
  primaryOnly?: boolean,
  loadPolicy?: typeof loadAutoReviewProviderPolicy,
): AutoReviewProviderCapability;
