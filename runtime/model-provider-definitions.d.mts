export type ManagedModelProviderId =
  | "deepseek"
  | "opencode-go"
  | `opencode-go-${string}`;

export interface ModelProviderDefinition {
  readonly id: ManagedModelProviderId;
  /** OpenCode Go 账户实例的账户 id（非账户实例为 undefined） */
  readonly accountId?: string;
  /** 存储目录归属，OpenCode Go 账户共享 `opencode-go` 目录 */
  readonly storageId?: string;
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

export function loadOpencodeGoAccountDefinitions(
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
export function loadManagedModelProviderDefinitions(
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
