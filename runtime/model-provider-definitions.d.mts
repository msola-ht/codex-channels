export interface ModelProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly profileName: string;
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
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly available: boolean;
    readonly unavailableReason?: string;
  }>;
}

export const deepseekProviderDefinition: ModelProviderDefinition;
