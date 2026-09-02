import {
  loadOpencodeGoAccounts,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
  opencodeGoAccountDisplayName,
} from "./opencode-go-accounts.mjs";

const managedProviderCapabilityKinds = Object.freeze({
  catalogSources: new Set(["none", "deepseek-official"]),
  pricingAdapters: new Set(["none", "remote", "deepseek", "opencode-go"]),
  accountAdapters: new Set(["none", "deepseek", "opencode-go"]),
  instanceAdapters: new Set(["single", "opencode-go-accounts"]),
  catalogUpdateAdapters: new Set(["none", "deepseek", "opencode-go"]),
});

const deepseekProviderCapabilities = Object.freeze({
  catalogSource: "deepseek-official",
  pricingAdapter: "deepseek",
  accountAdapter: "deepseek",
  instanceAdapter: "single",
  catalogUpdateAdapter: "deepseek",
  needsExchangeRate: true,
});

const opencodeGoProviderCapabilities = Object.freeze({
  catalogSource: "deepseek-official",
  pricingAdapter: "opencode-go",
  accountAdapter: "opencode-go",
  instanceAdapter: "opencode-go-accounts",
  catalogUpdateAdapter: "opencode-go",
  needsExchangeRate: false,
});

const deepseekProfileName = "sf-deepseek";
// 仅用于识别迁移前的单账户 Profile；实际账户 Profile 一律由账户 ID 派生。
const opencodeGoLegacyProfileName = "sf-opencode-go";

export const deepseekProviderDefinition = Object.freeze({
  id: "deepseek",
  displayName: "DeepSeek",
  profileName: deepseekProfileName,
  profileFileName: `${deepseekProfileName}.config.toml`,
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://api.deepseek.com/",
  wireApi: "responses",
  apiKeyEnvironmentKey: "CODEX_CONNECT_DEEPSEEK_API_KEY",
  defaultModel: "deepseek-v4-flash-vision-exp",
  defaultReasoningEffort: "high",
  capabilities: deepseekProviderCapabilities,
  models: Object.freeze([
    Object.freeze({ slug: "deepseek-v4-flash", available: true }),
    Object.freeze({ slug: "deepseek-v4-flash-vision-exp", available: true }),
    Object.freeze({ slug: "deepseek-v4-pro", available: true }),
  ]),
});

export const opencodeGoProviderDefinition = Object.freeze({
  id: "ocg",
  storageId: "opencode-go",
  displayName: "OpenCode Go",
  profileName: opencodeGoLegacyProfileName,
  profileFileName: `${opencodeGoLegacyProfileName}.config.toml`,
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://opencode.ai/zen/go/v1",
  wireApi: "responses",
  apiKeyEnvironmentKey: "CODEX_CONNECT_OPENCODE_GO_API_KEY",
  defaultModel: "deepseek-v4-flash-vision-exp",
  defaultReasoningEffort: "high",
  supportsWebsockets: false,
  capabilities: opencodeGoProviderCapabilities,
  models: Object.freeze([
    Object.freeze({ slug: "deepseek-v4-flash", available: true }),
    Object.freeze({ slug: "deepseek-v4-flash-vision-exp", available: true }),
    Object.freeze({ slug: "deepseek-v4-pro", available: true }),
  ]),
});

export const managedModelProviderDefinitions = Object.freeze([
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
]);

export function loadOpencodeGoAccountDefinitions(environment = process.env) {
  return loadOpencodeGoAccounts(environment).map((account) =>
    opencodeGoAccountDefinition(account.id, account.email, account.phone));
}

export function loadManagedModelProviderDefinitions(environment = process.env) {
  return expandManagedModelProviderDefinitions(
    managedModelProviderDefinitions,
    environment,
  );
}

export function loadManagedModelProviderWatcherDefinitions(environment = process.env) {
  return Object.freeze(managedModelProviderDefinitions.flatMap((definition) => {
    const capabilities = assertManagedModelProviderCapabilities(definition);
    const expanded = expandManagedModelProviderDefinitions([definition], environment);
    return capabilities.instanceAdapter === "single"
      ? expanded
      : [definition, ...expanded];
  }));
}

export function expandManagedModelProviderDefinitions(
  definitions,
  environment = process.env,
) {
  return Object.freeze(definitions.flatMap((definition) => {
    assertManagedModelProviderProfile(definition);
    const capabilities = assertManagedModelProviderCapabilities(definition);
    switch (capabilities.instanceAdapter) {
      case "single":
        return [definition];
      case "opencode-go-accounts":
        return loadOpencodeGoAccountDefinitions(environment);
      default:
        throw new Error(
          `未知受管 Provider 实例适配器：${String(capabilities.instanceAdapter)}`,
        );
    }
  }));
}

function assertManagedModelProviderProfile(definition) {
  if (
    typeof definition?.profileName !== "string"
    || !definition.profileName.startsWith("sf-")
    || definition.profileFileName !== `${definition.profileName}.config.toml`
  ) {
    const provider = typeof definition?.id === "string" ? definition.id : "unknown";
    throw new Error(`受管 Provider Profile 定义无效：${provider}`);
  }
}

export function opencodeGoAccountDefinition(accountId, email, phone) {
  const provider = opencodeGoProviderId(accountId);
  const profileName = `sf-ocg-${accountId}`;
  return Object.freeze({
    id: provider,
    accountId,
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    storageId: "opencode-go",
    displayName: opencodeGoAccountDisplayName({ id: accountId, email, phone }),
    profileName,
    profileFileName: `${profileName}.config.toml`,
    catalogFileName: opencodeGoProviderDefinition.catalogFileName,
    catalogManifestFileName: opencodeGoProviderDefinition.catalogManifestFileName,
    managedMarkerFileName: opencodeGoProviderDefinition.managedMarkerFileName,
    backupDirectoryName: opencodeGoProviderDefinition.backupDirectoryName,
    baseUrl: opencodeGoProviderDefinition.baseUrl,
    wireApi: opencodeGoProviderDefinition.wireApi,
    apiKeyEnvironmentKey: opencodeGoApiKeyEnvironmentKey(accountId),
    defaultModel: opencodeGoProviderDefinition.defaultModel,
    defaultReasoningEffort: opencodeGoProviderDefinition.defaultReasoningEffort,
    supportsWebsockets: false,
    capabilities: opencodeGoProviderDefinition.capabilities,
    models: opencodeGoProviderDefinition.models,
  });
}

export function assertManagedModelProviderCapabilities(definition) {
  const capabilities = definition?.capabilities;
  if (
    capabilities === null
    || typeof capabilities !== "object"
    || Array.isArray(capabilities)
    || !managedProviderCapabilityKinds.catalogSources.has(capabilities.catalogSource)
    || !managedProviderCapabilityKinds.pricingAdapters.has(capabilities.pricingAdapter)
    || !managedProviderCapabilityKinds.accountAdapters.has(capabilities.accountAdapter)
    || !managedProviderCapabilityKinds.instanceAdapters.has(capabilities.instanceAdapter)
    || !managedProviderCapabilityKinds.catalogUpdateAdapters.has(
      capabilities.catalogUpdateAdapter,
    )
    || (
      capabilities.catalogUpdateAdapter !== "none"
      && capabilities.catalogSource === "none"
    )
    || typeof capabilities.needsExchangeRate !== "boolean"
  ) {
    const provider = typeof definition?.id === "string" ? definition.id : "unknown";
    throw new Error(`受管 Provider 能力定义无效：${provider}`);
  }
  return capabilities;
}
