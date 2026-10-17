import {
  loadOpencodeGoAccounts,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
  opencodeGoAccountDisplayName,
  opencodeGoAccountIdFromProvider,
  isOpencodeGoProvider,
  opencodeGoAccountMarkerPath,
  opencodeGoAccountsFilePath,
} from "./opencode-go-accounts.mjs";
import { loadDeepseekAccounts, deepseekProviderId, deepseekApiKeyEnvironmentKey,
  deepseekAccountIdFromProvider, isDeepseekAccountProvider, deepseekAccountMarkerPath,
  deepseekAccountsFilePath } from "./deepseek-accounts.mjs";
import { loadCcgAccounts, ccgProviderId, ccgApiKeyEnvironmentKey,
  ccgAccountIdFromProvider, isCcgAccountProvider, ccgAccountMarkerPath,
  ccgAccountsFilePath } from "./ccg-accounts.mjs";
import { loadClinePassAccounts, clinePassProviderId, clinePassApiKeyEnvironmentKey,
  clinePassAccountIdFromProvider, isClinePassAccountProvider, clinePassAccountMarkerPath,
  clinePassAccountsFilePath } from "./cline-pass-accounts.mjs";

const deepseekProviderCapabilities = Object.freeze({
  accountAdapter: "deepseek",
  instanceAdapter: "deepseek-accounts",
});

const opencodeGoProviderCapabilities = Object.freeze({
  accountAdapter: "opencode-go",
  instanceAdapter: "opencode-go-accounts",
});

export const deepseekProviderDefinition = Object.freeze({
  id: "deepseek",
  displayName: "DeepSeek",
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://api.deepseek.com/",
  wireApi: "responses",
  webSearch: "disabled",
  apiKeyEnvironmentKey: "CODEX_CONNECT_DEEPSEEK_API_KEY",
  defaultModel: "deepseek-flash",
  defaultReasoningEffort: "high",
  capabilities: deepseekProviderCapabilities,
});

export const opencodeGoProviderDefinition = Object.freeze({
  id: "ocg",
  storageId: "opencode-go",
  displayName: "OpenCode Go",
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://opencode.ai/zen/go/v1",
  wireApi: "responses",
  webSearch: "disabled",
  apiKeyEnvironmentKey: "CODEX_CONNECT_OPENCODE_GO_API_KEY",
  defaultModel: "deepseek-flash",
  defaultReasoningEffort: "high",
  supportsWebsockets: false,
  capabilities: opencodeGoProviderCapabilities,
});

export const commandCodeProviderDefinition = Object.freeze({
  id: "ccg",
  displayName: "CommandCode Go",
  catalogFileName: "models.json",
  catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml",
  backupDirectoryName: "backup",
  baseUrl: "https://api.commandcode.ai/provider/v1",
  wireApi: "responses",
  webSearch: "disabled",
  apiKeyEnvironmentKey: "CODEX_CONNECT_CCG_API_KEY",
  supportsWebsockets: false,
  capabilities: Object.freeze({
    accountAdapter: "ccg",
    instanceAdapter: "ccg-accounts",
  }),
});

export const clinePassProviderDefinition = Object.freeze({
  id: "clp", displayName: "Cline Pass",
  catalogFileName: "models.json", catalogManifestFileName: "models.manifest.json",
  managedMarkerFileName: "managed.toml", backupDirectoryName: "backup",
  baseUrl: "https://api.cline.bot/api/v1", wireApi: "responses",
  upstreamWireApi: "chat_completions",
  webSearch: "disabled",
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
  if ((definition.storageId ?? definition.id) === "clp") {
    return typeof model === "string"
      && model.length <= 200
      && model.startsWith("cline-pass/")
      && model.slice("cline-pass/".length).trim().length > 0
      && model.trim() === model
      && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(model);
  }
  return typeof model === "string" && ((definition.storageId ?? definition.id) === "ccg"
    ? /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(model)
    : /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(model));
}

/** 编译期账户家族登记；各账户模块仍拥有注册表读取和路径校验。 */
export const managedProviderAccountFamilies = Object.freeze([
  {
    definition: deepseekProviderDefinition,
    aggregateMaterialOrder: 0,
    matches: isDeepseekAccountProvider,
    accountId: deepseekAccountIdFromProvider,
    providerId: deepseekProviderId,
    loadAccounts: loadDeepseekAccounts,
    markerPath: deepseekAccountMarkerPath,
    accountsFilePath: deepseekAccountsFilePath,
    accountDefinition: (account) => deepseekAccountDefinition(account.id),
  },
  {
    definition: opencodeGoProviderDefinition,
    aggregateMaterialOrder: 3,
    matches: isOpencodeGoProvider,
    accountId: opencodeGoAccountIdFromProvider,
    providerId: opencodeGoProviderId,
    loadAccounts: loadOpencodeGoAccounts,
    markerPath: opencodeGoAccountMarkerPath,
    accountsFilePath: opencodeGoAccountsFilePath,
    accountDefinition: (account) => opencodeGoAccountDefinition(account.id, account.email, account.phone),
  },
  {
    definition: commandCodeProviderDefinition,
    aggregateMaterialOrder: 2,
    matches: isCcgAccountProvider,
    accountId: ccgAccountIdFromProvider,
    providerId: ccgProviderId,
    loadAccounts: loadCcgAccounts,
    markerPath: ccgAccountMarkerPath,
    accountsFilePath: ccgAccountsFilePath,
    accountDefinition: (account) => ccgAccountDefinition(account.id),
  },
  {
    definition: clinePassProviderDefinition,
    aggregateMaterialOrder: 1,
    matches: isClinePassAccountProvider,
    accountId: clinePassAccountIdFromProvider,
    providerId: clinePassProviderId,
    loadAccounts: loadClinePassAccounts,
    markerPath: clinePassAccountMarkerPath,
    accountsFilePath: clinePassAccountsFilePath,
    accountDefinition: (account) => clinePassAccountDefinition(account.id),
  },
].map((family) => Object.freeze({
  ...family,
  proxyKey: family.definition.id,
  storageId: family.definition.storageId ?? family.definition.id,
  accountAdapter: family.definition.capabilities.accountAdapter,
  instanceAdapter: family.definition.capabilities.instanceAdapter,
})));

export const managedModelProviderDefinitions = Object.freeze(
  managedProviderAccountFamilies.map((family) => family.definition),
);

/** 共享代理键（如 clp、ocg）对应的基础定义；账户展开后的列表不包含这些键。 */
export function sharedManagedProviderDefinition(proxyKey) {
  return managedModelProviderDefinitions.find(
    (definition) => definition.id === proxyKey || definition.storageId === proxyKey,
  );
}

export function loadOpencodeGoAccountDefinitions(environment = process.env) {
  const family = managedProviderAccountFamilies.find((candidate) => candidate.proxyKey === "ocg");
  return family.loadAccounts(environment).map(family.accountDefinition);
}

export function loadManagedModelProviderDefinitions(environment = process.env) {
  return expandManagedModelProviderDefinitions(
    managedModelProviderDefinitions,
    environment,
  );
}

export function loadManagedModelProviderWatcherDefinitions(environment = process.env) {
  return loadManagedModelProviderDefinitions(environment);
}

export function expandManagedModelProviderDefinitions(
  definitions,
  environment = process.env,
) {
  return Object.freeze(definitions.flatMap((definition) => {
    const family = managedProviderAccountFamilyForDefinition(definition);
    if (family === undefined) {
      assertManagedModelProviderProfile(definition);
      return [definition];
    }
    return family.loadAccounts(environment).map(family.accountDefinition);
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
    webSearch: opencodeGoProviderDefinition.webSearch,
    apiKeyEnvironmentKey: opencodeGoApiKeyEnvironmentKey(accountId),
    defaultModel: opencodeGoProviderDefinition.defaultModel,
    defaultReasoningEffort: opencodeGoProviderDefinition.defaultReasoningEffort,
    supportsWebsockets: false,
    capabilities: opencodeGoProviderDefinition.capabilities,
  });
}

export function assertManagedModelProviderCapabilities(definition) {
  managedProviderAccountFamilyForDefinition(definition);
  return definition.capabilities;
}

export function managedProviderAccountFamilyForDefinition(definition) {
  const capabilities = definition?.capabilities;
  if (
    capabilities === null
    || typeof capabilities !== "object"
    || Array.isArray(capabilities)
  ) {
    const provider = typeof definition?.id === "string" ? definition.id : "unknown";
    throw new Error(`受管 Provider 能力定义无效：${provider}`);
  }
  if (capabilities.accountAdapter === "none" && capabilities.instanceAdapter === "single"
    && definition.accountId === undefined) return undefined;
  const family = managedProviderAccountFamilies.find((candidate) =>
    candidate.storageId === (definition.storageId ?? definition.id));
  if (family === undefined) throw new Error("受管 Provider 账户家族尚未登记");
  if (capabilities.accountAdapter !== family.accountAdapter
    || capabilities.instanceAdapter !== family.instanceAdapter
    || (definition.accountId === undefined
      ? definition.id !== family.definition.id
      : !family.matches(definition.id) || family.accountId(definition.id) !== definition.accountId)) {
    throw new Error("受管 Provider 账户家族、能力或实例身份不一致");
  }
  return family;
}
