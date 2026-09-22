import { basename, dirname, extname, join, resolve } from "node:path";

import { parse } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { loadDeepseekAccounts, deepseekProviderId, isDeepseekAccountProvider } from "./deepseek-accounts.mjs";
import {
  exclusiveManagedProviders,
  findManagedProviderDefinition,
  loadConfiguredProviderProfile,
  loadManagedProviderProfileFor,
  loadManagedProviderProfiles,
  providerDescriptor,
  readCodexConfigFile,
  readProviderProfile,
  record,
} from "./model-provider-managed-runtime.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
} from "./model-provider-custom-runtime.mjs";
import {
  thirdPartyProviderRequestMaxRetries,
  thirdPartyProviderStreamMaxRetries,
} from "./model-provider-profile.mjs";
import {
  loadOpencodeGoDefaultAccount,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
} from "./opencode-go-accounts.mjs";

export function loadManagedModelProvider(environment = process.env) {
  return loadManagedModelProviders(environment)[0];
}

export function loadManagedModelProviders(environment = process.env) {
  return loadManagedProviderProfiles(environment)
    .map((profile) => ({ provider: profile.provider }));
}

export function loadManagedProviderAppServer(environment = process.env) {
  return loadManagedProviderAppServers(environment)[0];
}

export function loadManagedProviderAppServers(environment = process.env) {
  return loadManagedProviderProfiles(environment, { requireLaunchConfig: true })
    .map(providerAppServerRuntime);
}

function providerAppServerRuntime(profile) {
  return {
    provider: profile.provider,
    arguments: [
      "-c", `model=${JSON.stringify(profile.model)}`,
      "-c", `model_provider=${JSON.stringify(profile.provider)}`,
      "-c", 'service_tier="default"',
      "-c", `model_catalog_json=${JSON.stringify(profile.catalogPath)}`,
      ...(profile.reasoningEffort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`]),
      "-c", `model_providers.${profile.provider}.name=${JSON.stringify(profile.name)}`,
      "-c", `model_providers.${profile.provider}.base_url=${JSON.stringify(profile.baseUrl)}`,
      "-c", `model_providers.${profile.provider}.wire_api=${JSON.stringify(profile.wireApi)}`,
      "-c", `model_providers.${profile.provider}.env_key=${JSON.stringify(profile.apiKeyEnvironmentKey)}`,
      "-c", `model_providers.${profile.provider}.requires_openai_auth=false`,
      ...(profile.supportsWebsockets === undefined
        ? []
        : ["-c", `model_providers.${profile.provider}.supports_websockets=${profile.supportsWebsockets}`]),
      "-c", `model_providers.${profile.provider}.request_max_retries=${thirdPartyProviderRequestMaxRetries}`,
      "-c", `model_providers.${profile.provider}.stream_max_retries=${thirdPartyProviderStreamMaxRetries}`,
    ],
    childEnvironment: {
      [profile.apiKeyEnvironmentKey]: profile.apiKey,
    },
  };
}


export function loadPrimaryModelProvider(environment = process.env) {
  const exclusiveProviders = exclusiveManagedProviders(environment);
  if (exclusiveProviders.length > 1) {
    throw new Error("只能有一个受管第三方 Provider 使用固定模式");
  }
  if (exclusiveProviders[0] !== undefined) return exclusiveProviders[0].id;
  // Gateway 的主 App Server 始终使用稳定的 openai 路由键；自定义 Provider 只改变其上游。
  loadConfiguredCustomPrimaryModelProvider(environment);
  return "openai";
}


export function loadOpenAiBaseUrl(environment = process.env) {
  const path = join(codexHomePath(environment), "config.toml");
  let document;
  try {
    document = record(parse(readCodexConfigFile(path)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // TOML 解析错误可能包含用户配置原文，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex OpenAI base URL 配置无法安全读取");
  }
  const configured = document.openai_base_url;
  if (configured === undefined) return undefined;
  if (typeof configured !== "string") {
    throw new Error("Codex openai_base_url 必须是 HTTP(S) URL");
  }
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("Codex openai_base_url 必须是 HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Codex openai_base_url 必须是无凭据、查询和片段的 HTTP(S) URL");
  }
  return url.toString();
}


export function providerAppServerSocketPath(primarySocketPath, provider) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-${provider}${extension}`);
}

export function providerMetricsSocketPath(primarySocketPath, provider) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-${provider}-metrics${extension}`);
}

export function withProviderBaseUrl(argumentsList, provider, baseUrl) {
  const prefixes = [
    `model_providers.${provider}.base_url=`,
    `model_providers.${provider}.request_max_retries=`,
    `model_providers.${provider}.stream_max_retries=`,
  ];
  const kept = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "-c") {
      const next = argumentsList[index + 1];
      if (
        typeof next === "string"
        && prefixes.some((prefix) => next.startsWith(prefix))
      ) {
        index += 1;
        continue;
      }
    }
    kept.push(value);
  }
  return [
    ...kept,
    "-c",
    `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    "-c",
    `model_providers.${provider}.request_max_retries=${thirdPartyProviderRequestMaxRetries}`,
    "-c",
    `model_providers.${provider}.stream_max_retries=${thirdPartyProviderStreamMaxRetries}`,
  ];
}

export function withOpenAiBaseUrl(argumentsList, baseUrl) {
  const prefix = "openai_base_url=";
  const kept = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "-c") {
      const next = argumentsList[index + 1];
      if (typeof next === "string" && next.startsWith(prefix)) {
        index += 1;
        continue;
      }
    }
    kept.push(value);
  }
  return [...kept, "-c", `openai_base_url=${JSON.stringify(baseUrl)}`];
}

export function loadDeepseekAccountCredential(environment = process.env, provider) {
  if (provider === undefined) {
    const account = loadDeepseekAccounts(environment).find((entry) => entry.default);
    if (!account) throw new Error("尚未配置 DeepSeek 默认账户");
    provider = deepseekProviderId(account.id);
  }
  const definition = isDeepseekAccountProvider(provider) && findManagedProviderDefinition(environment, provider);
  if (!definition) throw new Error(`未知 DeepSeek 账户：${provider}`);
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (!profile) throw new Error(`DeepSeek 账户尚未配置：${provider}`);
  return profile.apiKey;
}

export function loadOpencodeGoAccountCredential(environment = process.env) {
  const account = loadOpencodeGoDefaultAccount(environment);
  if (account === undefined) throw new Error("尚未配置 OpenCode Go 账户");
  return loadOpencodeGoAccountCredentialFor(opencodeGoProviderId(account.id), environment);
}

export function loadOpencodeGoAccountCredentialFor(provider, environment = process.env) {
  if (provider === undefined) return loadOpencodeGoAccountCredential(environment);
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) {
    throw new Error(`未知 OpenCode Go 账户：${provider}`);
  }
  if (
    definition.accountId !== undefined
    && readOpencodeGoAccountMarker(environment, definition.accountId)?.mode === "exclusive"
  ) {
    const configPath = join(codexHomePath(environment), "config.toml");
    return readProviderProfile(
      configPath,
      providerDescriptor(definition),
      { requireSelection: false },
    ).apiKey;
  }
  const managed = loadManagedProviderProfileFor(environment, definition);
  if (managed !== undefined) return managed.apiKey;
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (profile) return profile.apiKey;
  throw new Error(`OpenCode Go 账户尚未配置：${provider}`);
}


export function loadConfiguredProviderCredential(provider, environment = process.env) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) throw new Error(`未知第三方 Provider：${provider}`);
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (!profile) throw new Error(`${definition.displayName} Provider 尚未配置`);
  return {
    environmentKey: profile.apiKeyEnvironmentKey,
    apiKey: profile.apiKey,
  };
}
