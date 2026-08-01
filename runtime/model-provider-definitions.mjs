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
    Object.freeze({
      slug: "deepseek-v4-pro",
      available: false,
      unavailableReason: "DeepSeek 官方暂未支持该模型接入 Codex",
    }),
  ]),
});
