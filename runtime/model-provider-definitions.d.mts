export type ManagedModelProviderId =
  | "clp"
  | `clp-${string}`
  | "ccg"
  | `ccg-${string}`
  | "deepseek"
  | `ds-${string}`
  | "ocg"
  | `ocg-${string}`;

export type ManagedModelProviderAccountAdapter = "none" | "deepseek" | "opencode-go" | "ccg" | "clp";
export type ManagedModelProviderInstanceAdapter = "single" | "opencode-go-accounts" | "deepseek-accounts" | "ccg-accounts" | "clp-accounts";

export interface ModelProviderCapabilities {
  readonly accountAdapter: ManagedModelProviderAccountAdapter;
  readonly instanceAdapter: ManagedModelProviderInstanceAdapter;
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
  readonly upstreamWireApi?: "chat_completions";
  /** 上游不支持内置网页搜索时，在受管 App Server 中覆盖基础配置。 */
  readonly apiKeyEnvironmentKey: string;
  /** 自动生成目录的 Provider 默认值；CCG 必须由文件和用户选择提供。 */
  readonly defaultModel?: string;
  readonly defaultReasoningEffort?: string;
  readonly supportsWebsockets?: boolean;
  readonly capabilities: ModelProviderCapabilities;
}

export type ModelProviderTemplate = Omit<ModelProviderDefinition, "profileName" | "profileFileName">;

export interface ManagedProviderAccount {
  readonly id: string;
  readonly default: boolean;
  readonly email?: string;
  readonly phone?: string;
}

export interface ManagedProviderAccountFamily {
  readonly definition: ModelProviderTemplate;
  readonly proxyKey: ManagedModelProviderId;
  readonly storageId: string;
  readonly accountAdapter: Exclude<ManagedModelProviderAccountAdapter, "none">;
  readonly instanceAdapter: Exclude<ManagedModelProviderInstanceAdapter, "single">;
  /** 保留聚合材料既有路径顺序，避免仅登记重构改变材料指纹。 */
  readonly aggregateMaterialOrder: number;
  readonly matches: (provider: string) => boolean;
  readonly accountId: (provider: string) => string | undefined;
  readonly providerId: (accountId: string) => string;
  readonly loadAccounts: (environment?: NodeJS.ProcessEnv) => readonly ManagedProviderAccount[];
  readonly markerPath: (environment: NodeJS.ProcessEnv, accountId: string) => string;
  readonly accountsFilePath: (environment?: NodeJS.ProcessEnv) => string;
  readonly accountDefinition: (account: ManagedProviderAccount) => ModelProviderDefinition;
}

export const managedProviderAccountFamilies: readonly ManagedProviderAccountFamily[];
/** 非账户 single/none 定义返回 undefined；未登记家族和身份不一致明确失败。 */
export function managedProviderAccountFamilyForDefinition(
  definition: Partial<ModelProviderDefinition>,
): ManagedProviderAccountFamily | undefined;

export function clinePassAccountDefinition(accountId: string): ModelProviderDefinition;
export const clinePassProviderDefinition: ModelProviderTemplate;
export const deepseekProviderDefinition: ModelProviderTemplate;
export function deepseekAccountDefinition(accountId: string): ModelProviderDefinition;
export const commandCodeProviderDefinition: ModelProviderTemplate;
export function ccgAccountDefinition(accountId: string): ModelProviderDefinition;
export function isManagedProviderApiKeyValid(definition: ModelProviderTemplate, apiKey: unknown): boolean;
export function isManagedProviderModelValid(
  definition: Pick<ModelProviderDefinition, "id" | "storageId" | "defaultModel">,
  model: unknown,
): boolean;
export const opencodeGoProviderDefinition: ModelProviderTemplate;
export const managedModelProviderDefinitions: readonly ModelProviderTemplate[];
export function sharedManagedProviderDefinition(
  proxyKey: string,
): ModelProviderTemplate | undefined;

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
): readonly (ModelProviderTemplate | ModelProviderDefinition)[];
export function expandManagedModelProviderDefinitions(
  definitions: readonly ModelProviderTemplate[],
  environment?: NodeJS.ProcessEnv,
): readonly ModelProviderDefinition[];
export function assertManagedModelProviderCapabilities(
  definition: Partial<ModelProviderDefinition>,
): ModelProviderCapabilities;
