export const deepseekProviderDefinition = Object.freeze({
  id: "deepseek",
  displayName: "DeepSeek",
  profileName: "deepseek",
  profileFileName: "deepseek.config.toml",
  catalogFileName: "deepseek.models.json",
  catalogManifestFileName: "deepseek.models.manifest.json",
  managedMarkerFileName: "codex-connect-deepseek.config.toml",
  backupDirectoryName: "backup-codex-connect-deepseek",
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
  profileFileName: "opencode-go.config.toml",
  catalogFileName: deepseekProviderDefinition.catalogFileName,
  catalogManifestFileName: deepseekProviderDefinition.catalogManifestFileName,
  managedMarkerFileName: "codex-connect-opencode-go.config.toml",
  backupDirectoryName: "backup-codex-connect-opencode-go",
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
