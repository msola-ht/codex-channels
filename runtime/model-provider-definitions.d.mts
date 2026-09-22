export type ManagedModelProviderId =
  | "ccg"
  | `ccg-${string}`
  | "deepseek"
  | `ds-${string}`
  | "ocg"
  | `ocg-${string}`
  /** 仅用于读取遗留配置；运行时不再生成或接受该 Provider。 */
  | "opencode-go"
  | `opencode-go-${string}`;

export type ManagedModelProviderCatalogSource = "none" | "deepseek-official";
export type ManagedModelProviderAccountAdapter = "none" | "deepseek" | "opencode-go";
export type ManagedModelProviderInstanceAdapter = "single" | "opencode-go-accounts" | "deepseek-accounts" | "ccg-accounts";
export type ManagedModelProviderCatalogUpdateAdapter = "none" | "deepseek" | "opencode-go" | "ccg";

export interface ModelProviderCapabilities {
  readonly catalogSource: ManagedModelProviderCatalogSource;
  readonly accountAdapter: ManagedModelProviderAccountAdapter;
  readonly instanceAdapter: ManagedModelProviderInstanceAdapter;
  readonly catalogUpdateAdapter: ManagedModelProviderCatalogUpdateAdapter;
}

export interface ModelProviderDefinition {
  readonly id: ManagedModelProviderId;
  /** 受管账户实例的账户 id（非账户实例为 undefined） */
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
  /** 自动生成目录的 Provider 默认值；CCG 必须由文件和用户选择提供。 */
  readonly defaultModel?: string;
  readonly defaultReasoningEffort?: string;
  readonly supportsWebsockets?: boolean;
  readonly capabilities: ModelProviderCapabilities;
}

export const deepseekProviderDefinition: ModelProviderDefinition;
export function deepseekAccountDefinition(accountId: string): ModelProviderDefinition;
export const commandCodeProviderDefinition: ModelProviderDefinition;
export function ccgAccountDefinition(accountId: string): ModelProviderDefinition;
export function isManagedProviderApiKeyValid(definition: ModelProviderDefinition, apiKey: unknown): boolean;
export function isManagedProviderModelValid(
  definition: Pick<ModelProviderDefinition, "id" | "storageId">,
  model: unknown,
): boolean;
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
