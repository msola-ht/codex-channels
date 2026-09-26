import {
  loadOpencodeGoAccounts,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
  opencodeGoAccountDisplayName,
} from "./opencode-go-accounts.mjs";
import { loadDeepseekAccounts, deepseekProviderId, deepseekApiKeyEnvironmentKey } from "./deepseek-accounts.mjs";
import { loadCcgAccounts, ccgProviderId, ccgApiKeyEnvironmentKey } from "./ccg-accounts.mjs";
import { loadClinePassAccounts, clinePassProviderId, clinePassApiKeyEnvironmentKey } from "./cline-pass-accounts.mjs";

const managedProviderCapabilityKinds = Object.freeze({
  accountAdapters: new Set(["none", "deepseek", "opencode-go", "ccg", "clp"]),
  instanceAdapters: new Set(["single", "opencode-go-accounts", "deepseek-accounts", "ccg-accounts", "clp-accounts"]),
});

const deepseekProviderCapabilities = Object.freeze({
  accountAdapter: "deepseek",
  instanceAdapter: "deepseek-accounts",
});

const opencodeGoProviderCapabilities = Object.freeze({
  accountAdapter: "opencode-go",
  instanceAdapter: "opencode-go-accounts",
});

const deepseekProfileName = "sf-deepseek";
// 仅用于识别待移除的旧单账户 Profile；实际账户 Profile 一律由账户 ID 派生。
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
  defaultModel: "deepseek-flash",
  defaultReasoningEffort: "high",
  capabilities: deepseekProviderCapabilities,
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
  defaultModel: "deepseek-flash",
  defaultReasoningEffort: "high",
  supportsWebsockets: false,
  capabilities: opencodeGoProviderCapabilities,
});

export const commandCodeProviderDefinition = Object.freeze({
  id: "ccg",
  displayName: "CommandCode Go",
  profileName: "sf-ccg",
  profileFileName: "sf-ccg.config.toml",
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://api.commandcode.ai/provider/v1",
  wireApi: "responses",
  apiKeyEnvironmentKey: "CODEX_CONNECT_CCG_API_KEY",
  supportsWebsockets: false,
  capabilities: Object.freeze({
    accountAdapter: "ccg",
    instanceAdapter: "ccg-accounts",
  }),
});

export const clinePassProviderDefinition = Object.freeze({
  id: "clp", displayName: "Cline Pass",
  profileName: "sf-clp", profileFileName: "sf-clp.config.toml",
  catalogFileName: "models.json", catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml", backupDirectoryName: "backup",
  baseUrl: "https://api.cline.bot/api/v1", wireApi: "responses",
  upstreamWireApi: "chat_completions",
  apiKeyEnvironmentKey: "CODEX_CONNECT_CLP_API_KEY",
  defaultModel: "cline-pass/deepseek-v4.1-flash", defaultReasoningEffort: "high",
  supportsWebsockets: false,
  capabilities: Object.freeze({ accountAdapter: "clp", instanceAdapter: "clp-accounts" }),
});

export function isManagedProviderApiKeyValid(definition, apiKey) {
  return typeof apiKey === "string"
    && apiKey.length <= 4_096
    && (["ccg", "clp"].includes(definition.storageId ?? definition.id)
      ? /^[A-Za-z0-9._~+/-]+=*$/u.test(apiKey)
      : /^sk-[^\s"]+$/u.test(apiKey));
}

export function isManagedProviderModelValid(definition, model) {
  if ((definition.storageId ?? definition.id) === "clp") return model === clinePassProviderDefinition.defaultModel;
  return typeof model === "string" && ((definition.storageId ?? definition.id) === "ccg"
    ? /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(model)
    : /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(model));
}

export const managedModelProviderDefinitions = Object.freeze([
  deepseekProviderDefinition,
  opencodeGoProviderDefinition,
  commandCodeProviderDefinition,
  clinePassProviderDefinition,
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
      case "deepseek-accounts":
        return loadDeepseekAccounts(environment).map((account) => deepseekAccountDefinition(account.id));
      case "clp-accounts":
        return loadClinePassAccounts(environment).map((account) => clinePassAccountDefinition(account.id));
      case "ccg-accounts":
        return loadCcgAccounts(environment).map((account) => ccgAccountDefinition(account.id));
      default:
        throw new Error(
          `未知受管 Provider 实例适配器：${String(capabilities.instanceAdapter)}`,
        );
    }
  }));
}

export function deepseekAccountDefinition(accountId) {
  const id = deepseekProviderId(accountId);
  const profileName = `sf-${id}`;
  return Object.freeze({
    ...deepseekProviderDefinition,
    id, accountId, storageId: "deepseek", displayName: `DS ${accountId}`,
    profileName, profileFileName: `${profileName}.config.toml`,
    apiKeyEnvironmentKey: deepseekApiKeyEnvironmentKey(accountId),
  });
}

export function ccgAccountDefinition(accountId) {
  const id = ccgProviderId(accountId);
  const profileName = `sf-${id}`;
  return Object.freeze({
    ...commandCodeProviderDefinition,
    id, accountId, storageId: "ccg", displayName: `CommandCode Go ${accountId}`,
    profileName, profileFileName: `${profileName}.config.toml`,
    apiKeyEnvironmentKey: ccgApiKeyEnvironmentKey(accountId),
  });
}

export function clinePassAccountDefinition(accountId) {
  const id = clinePassProviderId(accountId);
  const profileName = `sf-${id}`;
  return Object.freeze({
    ...clinePassProviderDefinition,
    id, accountId, storageId: "clp", displayName: `Cline Pass ${accountId}`,
    profileName, profileFileName: `${profileName}.config.toml`,
    apiKeyEnvironmentKey: clinePassApiKeyEnvironmentKey(accountId),
  });
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
  });
}

export function assertManagedModelProviderCapabilities(definition) {
  const capabilities = definition?.capabilities;
  if (
    capabilities === null
    || typeof capabilities !== "object"
    || Array.isArray(capabilities)
    || !managedProviderCapabilityKinds.accountAdapters.has(capabilities.accountAdapter)
    || !managedProviderCapabilityKinds.instanceAdapters.has(capabilities.instanceAdapter)
  ) {
    const provider = typeof definition?.id === "string" ? definition.id : "unknown";
    throw new Error(`受管 Provider 能力定义无效：${provider}`);
  }
  return capabilities;
}
