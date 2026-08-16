export type ManagedModelProviderId = "deepseek" | "opencode-go";

export interface ModelProviderDefinition {
  readonly id: ManagedModelProviderId;
  readonly displayName: string;
  readonly profileName: string;
  readonly codexProfileName: string;
  readonly profileFileName: string;
  readonly catalogFileName: string;
  readonly catalogManifestFileName: string;
  readonly managedMarkerFileName: string;
  readonly backupDirectoryName: string;
  readonly baseUrl: string;
  readonly wireApi: "responses";
  readonly apiKeyEnvironmentKey: string;
  readonly defaultModel: string;
  readonly defaultReasoningEffort: string;
  readonly supportsWebsockets?: boolean;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly available: boolean;
    readonly unavailableReason?: string;
  }>;
}

export const deepseekProviderDefinition: ModelProviderDefinition;
export const opencodeGoProviderDefinition: ModelProviderDefinition;
export const managedModelProviderDefinitions: readonly ModelProviderDefinition[];
