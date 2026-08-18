import {
  loadOpencodeGoAccounts,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
} from "./opencode-go-accounts.mjs";

export const deepseekProviderDefinition = Object.freeze({
  id: "deepseek",
  displayName: "DeepSeek",
  profileName: "deepseek",
  codexProfileName: "sf-deepseek",
  profileFileName: "sf-deepseek.config.toml",
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://api.deepseek.com/",
  wireApi: "responses",
  apiKeyEnvironmentKey: "CODEX_CONNECT_DEEPSEEK_API_KEY",
  defaultModel: "deepseek-v4-flash",
  defaultReasoningEffort: "high",
  models: Object.freeze([
    Object.freeze({ slug: "deepseek-v4-flash", available: true }),
    Object.freeze({ slug: "deepseek-v4-pro", available: true }),
  ]),
});

export const opencodeGoProviderDefinition = Object.freeze({
  id: "opencode-go",
  displayName: "OpenCode Go",
  profileName: "opencode-go",
  codexProfileName: "sf-opencode-go",
  profileFileName: "sf-opencode-go.config.toml",
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://opencode.ai/zen/go/v1",
  wireApi: "responses",
  apiKeyEnvironmentKey: "CODEX_CONNECT_OPENCODE_GO_API_KEY",
  defaultModel: "deepseek-v4-flash",
  defaultReasoningEffort: "high",
  supportsWebsockets: false,
  models: Object.freeze([
    Object.freeze({ slug: "deepseek-v4-flash", available: true }),
    Object.freeze({ slug: "deepseek-v4-pro", available: true }),
  ]),
});

export const managedModelProviderDefinitions = Object.freeze([
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
]);

export function loadOpencodeGoAccountDefinitions(environment = process.env) {
  return loadOpencodeGoAccounts(environment).map((account) =>
    Object.freeze(opencodeGoAccountDefinition(account.id)));
}

export function loadManagedModelProviderDefinitions(environment = process.env) {
  return Object.freeze([
    deepseekProviderDefinition,
    ...loadOpencodeGoAccountDefinitions(environment),
  ]);
}

function opencodeGoAccountDefinition(accountId) {
  return {
    id: opencodeGoProviderId(accountId),
    accountId,
    storageId: "opencode-go",
    displayName: `OpenCode Go（${accountId}）`,
    profileName: opencodeGoProviderId(accountId),
    codexProfileName: `sf-opencode-go-${accountId}`,
    profileFileName: `sf-opencode-go-${accountId}.config.toml`,
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
    models: opencodeGoProviderDefinition.models,
  };
}
