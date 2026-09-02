export type ManagedModelProviderId =
  | "deepseek"
  | "ocg"
  | `ocg-${string}`
  /** 仅用于读取遗留配置；运行时不再生成或接受该 Provider。 */
  | "opencode-go"
  | `opencode-go-${string}`;

export type ManagedModelProviderCatalogSource = "none" | "deepseek-official";
export type ManagedModelProviderPricingAdapter =
  | "none"
  | "remote"
  | "deepseek"
  | "opencode-go";
export type ManagedModelProviderAccountAdapter = "none" | "deepseek" | "opencode-go";
export type ManagedModelProviderInstanceAdapter = "single" | "opencode-go-accounts";
export type ManagedModelProviderCatalogUpdateAdapter = "none" | "deepseek" | "opencode-go";

export interface ModelProviderCapabilities {
  readonly catalogSource: ManagedModelProviderCatalogSource;
  readonly pricingAdapter: ManagedModelProviderPricingAdapter;
  readonly accountAdapter: ManagedModelProviderAccountAdapter;
  readonly instanceAdapter: ManagedModelProviderInstanceAdapter;
  readonly catalogUpdateAdapter: ManagedModelProviderCatalogUpdateAdapter;
  readonly needsExchangeRate: boolean;
}

export interface ModelProviderDefinition {
  readonly id: ManagedModelProviderId;
  /** OpenCode Go 账户实例的账户 id（非账户实例为 undefined） */
  readonly accountId?: string;
  /** OpenCode Go 账户展示与指标身份使用的邮箱或手机号 */
  readonly email?: string;
  readonly phone?: string;
  /** 存储目录归属，OpenCode Go 账户共享 `opencode-go` 目录 */
  readonly storageId?: string;
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
  readonly supportsWebsockets?: boolean;
  readonly capabilities: ModelProviderCapabilities;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly available: boolean;
    readonly unavailableReason?: string;
  }>;
}

export const deepseekProviderDefinition: ModelProviderDefinition;
export const opencodeGoProviderDefinition: ModelProviderDefinition;
export const managedModelProviderDefinitions: readonly ModelProviderDefinition[];

export function opencodeGoAccountDefinition(
  accountId: string,
  email?: string,
  phone?: string,
): ModelProviderDefinition;
export function loadOpencodeGoAccountDefinitions(
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
export function loadManagedModelProviderDefinitions(
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
export function loadManagedModelProviderWatcherDefinitions(
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
export function expandManagedModelProviderDefinitions(
  definitions: readonly ModelProviderDefinition[],
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
export function assertManagedModelProviderCapabilities(
  definition: Partial<ModelProviderDefinition>,
): ModelProviderCapabilities;
