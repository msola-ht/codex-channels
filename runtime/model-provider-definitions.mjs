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
