import { join } from "node:path";

import {
  readGatewayConfig,
  withGatewayConfigLock,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  readApiProviderKey,
  removeApiProviderKey,
  writeApiProviderKey,
} from "../runtime/api-provider-credential.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export function listApiProviders(environment = process.env) {
  const context = loadApiProviderContext(environment);
  return {
    configPath: context.configPath,
    providers: context.providers.map((provider) => ({
      ...provider,
      hasApiKey: optionalProviderKey(context.credentialsDirectory, provider.id) !== undefined,
    })),
  };
}

export function saveApiProvider(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  const { configPath } = requireUserConfig(environment);
  return withGatewayConfigLock(configPath, () => saveApiProviderLocked(input, options));
}

function saveApiProviderLocked(
  { operation, id, name, endpoint, apiKey },
  { environment = process.env, writeConfig = writeGatewayConfig },
) {
  if (operation !== "create" && operation !== "update") {
    throw new Error(`未知直接 API Provider 保存操作：${String(operation)}`);
  }
  const context = loadApiProviderContext(environment);
  const providerId = normalizedProviderId(id);
  const existing = context.providers.find((provider) => provider.id === providerId);
  if (operation === "create" && existing !== undefined) {
    throw new Error("Provider ID 已存在，请使用“编辑 Provider”");
  }
  if (operation === "update" && existing === undefined) {
    throw new Error(`找不到直接 API Provider：${providerId}`);
  }
  const existingProviderKey = optionalProviderKey(context.credentialsDirectory, providerId);
  const nextKey = normalizedOptionalApiKey(apiKey) ?? existingProviderKey;
  if (nextKey === undefined) throw new Error("API Key 不能为空");
  const provider = {
    id: providerId,
    name: normalizedProviderName(name),
    protocol: "responses",
    endpoint: normalizedEndpoint(endpoint),
  };
  const previousProviders = context.document.api_providers;
  const nextProviders = existing === undefined
    ? [...context.providers, provider]
    : context.providers.map((candidate) => candidate.id === providerId ? provider : candidate);
  try {
    writeApiProviderKey(context.credentialsDirectory, providerId, nextKey);
    context.document.api_providers = nextProviders;
    writeConfig(context.configPath, context.document);
  } catch (error) {
    const confirmation = confirmProviderSave(context.configPath, provider);
    if (confirmation.applied) {
      return savedProviderResult(existing, provider, context.configPath);
    }
    if (confirmation.error !== undefined) {
      throw new AggregateError(
        [error, confirmation.error],
        "直接 API Provider 保存结果无法确认；新凭据已保留，请检查配置后重试",
        { cause: error },
      );
    }
    context.document.api_providers = previousProviders;
    try {
      if (existingProviderKey === undefined) {
        removeApiProviderKey(context.credentialsDirectory, providerId);
      } else {
        writeApiProviderKey(context.credentialsDirectory, providerId, existingProviderKey);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "直接 API Provider 保存失败，且凭据回滚失败",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return savedProviderResult(existing, provider, context.configPath);
}

function savedProviderResult(existing, provider, configPath) {
  return {
    action: existing === undefined ? "created" : "updated",
    provider: { ...provider, hasApiKey: true },
    configPath,
    activation: "restart-gateway",
    activationResult: configActivationResult("restart-gateway"),
  };
}

export function deleteApiProvider(
  id,
  options = {},
) {
  const environment = options.environment ?? process.env;
  const { configPath } = requireUserConfig(environment);
  return withGatewayConfigLock(configPath, () => deleteApiProviderLocked(id, options));
}

function deleteApiProviderLocked(
  id,
  { environment = process.env, writeConfig = writeGatewayConfig },
) {
  const context = loadApiProviderContext(environment);
  const providerId = normalizedProviderId(id);
  const provider = context.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new Error(`找不到直接 API Provider：${providerId}`);
  const previousKey = optionalProviderKey(context.credentialsDirectory, providerId);
  const previousProviders = context.document.api_providers;
  try {
    removeApiProviderKey(context.credentialsDirectory, providerId);
    context.document.api_providers = context.providers.filter(
      (candidate) => candidate.id !== providerId,
    );
    writeConfig(context.configPath, context.document);
  } catch (error) {
    const confirmation = confirmProviderRemoval(context.configPath, providerId);
    if (confirmation.applied) {
      return removedProviderResult(providerId, context.configPath);
    }
    if (confirmation.error !== undefined) {
      try {
        if (previousKey !== undefined) {
          writeApiProviderKey(context.credentialsDirectory, providerId, previousKey);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, confirmation.error, rollbackError],
          "直接 API Provider 删除结果无法确认，且原凭据恢复失败",
          { cause: rollbackError },
        );
      }
      throw new AggregateError(
        [error, confirmation.error],
        "直接 API Provider 删除结果无法确认；原凭据已保留，请检查配置后重试",
        { cause: error },
      );
    }
    context.document.api_providers = previousProviders;
    try {
      if (previousKey !== undefined) {
        writeApiProviderKey(context.credentialsDirectory, providerId, previousKey);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "直接 API Provider 删除失败，且凭据回滚失败",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return removedProviderResult(providerId, context.configPath);
}

function removedProviderResult(providerId, configPath) {
  return {
    action: "removed",
    provider: providerId,
    configPath,
    activation: "restart-gateway",
    activationResult: configActivationResult("restart-gateway"),
  };
}

function confirmProviderSave(configPath, expectedProvider) {
  return confirmProviderState(configPath, (providers) => {
    const provider = providers.find(({ id }) => id === expectedProvider.id);
    return provider !== undefined
      && provider.name === expectedProvider.name
      && provider.protocol === expectedProvider.protocol
      && provider.endpoint === expectedProvider.endpoint;
  });
}

function confirmProviderRemoval(configPath, providerId) {
  return confirmProviderState(
    configPath,
    (providers) => providers.every(({ id }) => id !== providerId),
  );
}

function confirmProviderState(configPath, predicate) {
  try {
    return {
      applied: predicate(providerList(readGatewayConfig(configPath).api_providers)),
    };
  } catch (error) {
    return { applied: false, error };
  }
}

export function validateApiProviderId(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(stringValue(value))
    ? undefined
    : "请输入 1–64 位小写字母、数字、- 或 _，且以字母或数字开头";
}

export function validateApiProviderName(value) {
  const normalized = stringValue(value);
  return normalized.length > 0 && normalized.length <= 64
    ? undefined
    : "显示名称长度必须为 1–64 个字符";
}

export function validateApiProviderEndpoint(value) {
  try {
    normalizedEndpoint(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function loadApiProviderContext(environment) {
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  return {
    configPath,
    credentialsDirectory: join(dataDir, "credentials"),
    document,
    providers: providerList(document.api_providers),
  };
}

function providerList(value) {
  return Array.isArray(value) ? value.map((candidate) => ({
    id: normalizedProviderId(candidate.id),
    name: normalizedProviderName(candidate.name),
    protocol: "responses",
    endpoint: normalizedEndpoint(candidate.endpoint),
  })) : [];
}

function optionalProviderKey(credentialsDirectory, providerId) {
  try {
    return readApiProviderKey(credentialsDirectory, providerId);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizedProviderId(value) {
  const normalized = stringValue(value);
  const error = validateApiProviderId(normalized);
  if (error) throw new Error(error);
  return normalized;
}

function normalizedProviderName(value) {
  const normalized = stringValue(value);
  const error = validateApiProviderName(normalized);
  if (error) throw new Error(error);
  return normalized;
}

function normalizedEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(stringValue(value));
  } catch {
    throw new Error("请输入有效 URL");
  }
  const loopback = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("必须使用 HTTPS；本机回环地址可以使用 HTTP");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("地址不能包含凭据、Query 或 Fragment");
  }
  return endpoint.toString();
}

function normalizedOptionalApiKey(value) {
  return stringValue(value) || undefined;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
