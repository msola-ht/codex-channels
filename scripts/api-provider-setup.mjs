import { join } from "node:path";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  readApiProviderKey,
  removeApiProviderKey,
  writeApiProviderKey,
} from "../runtime/api-provider-credential.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runApiProviderSetup({
  environment = process.env,
  output = process.stdout,
  prompts,
  writeConfig = writeGatewayConfig,
} = {}) {
  if (!prompts) throw new Error("第三方 API Setup 缺少交互实现");
  const { configPath, dataDir } = requireUserConfig(environment);
  const credentialsDirectory = join(dataDir, "credentials");
  const document = readGatewayConfig(configPath);
  const providers = providerList(document.api_providers);
  const action = await prompts.select({
    message: "直接 API Provider（预留）",
    showInstructions: false,
    options: [
      { value: "create", label: "新增 Provider", hint: "Responses 兼容接口与独立 API Key" },
      ...(providers.length > 0
        ? [
            { value: "edit", label: "编辑 Provider", hint: "修改名称、接口或 API Key" },
            { value: "remove", label: "删除 Provider", hint: "同时删除该 Provider 凭据" },
          ]
        : []),
      { value: "back", label: "返回", hint: "返回第三方 Provider 设置" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "remove") {
    return removeProvider({
      configPath,
      credentialsDirectory,
      document,
      providers,
      prompts,
      output,
      writeConfig,
      environment,
    });
  }
  if (action !== "create" && action !== "edit") {
    throw new Error(`未知第三方 API 操作：${String(action)}`);
  }

  let existing;
  let providerId;
  if (action === "edit") {
    existing = await selectProvider(providers, prompts, "选择要编辑的 Provider");
    if (existing === undefined) return { action: "back" };
    providerId = existing.id;
  } else {
    const id = await prompts.text({
      message: "Provider ID（小写字母、数字、-、_）",
      validate: (value) => validateProviderId(value)
        ?? (providers.some((provider) => provider.id === stringValue(value))
          ? "Provider ID 已存在，请使用“编辑 Provider”"
          : undefined),
    });
    if (prompts.isCancel(id)) return { action: "back" };
    providerId = normalizedProviderId(id);
    if (providers.some((provider) => provider.id === providerId)) {
      throw new Error("Provider ID 已存在，请使用“编辑 Provider”");
    }
  }
  const name = await prompts.text({
    message: "显示名称",
    initialValue: existing?.name ?? providerId,
    validate: validateProviderName,
  });
  if (prompts.isCancel(name)) return { action: "back" };
  const endpoint = await prompts.text({
    message: "Responses API 地址",
    initialValue: existing?.endpoint ?? "",
    validate: validateEndpoint,
  });
  if (prompts.isCancel(endpoint)) return { action: "back" };
  const existingProviderKey = optionalProviderKey(credentialsDirectory, providerId);
  const retainedKey = existingProviderKey;
  const apiKey = await prompts.password({
    message: retainedKey
      ? "API Key（留空保留当前 Key）"
      : "API Key",
    validate: (value) => retainedKey || stringValue(value)
      ? undefined
      : "API Key 不能为空",
  });
  if (prompts.isCancel(apiKey)) return { action: "back" };
  const nextKey = stringValue(apiKey) || retainedKey;
  if (!nextKey) throw new Error("API Key 不能为空");
  const nextProvider = {
    id: providerId,
    name: normalizedProviderName(name),
    protocol: "responses",
    endpoint: normalizedEndpoint(endpoint),
  };
  const previousProviders = document.api_providers;
  const nextProviders = existing
    ? providers.map((provider) => provider.id === providerId ? nextProvider : provider)
    : [...providers, nextProvider];
  try {
    writeApiProviderKey(credentialsDirectory, providerId, nextKey);
    document.api_providers = nextProviders;
    writeConfig(configPath, document);
  } catch (error) {
    document.api_providers = previousProviders;
    if (existingProviderKey) {
      writeApiProviderKey(credentialsDirectory, providerId, existingProviderKey);
    }
    else removeApiProviderKey(credentialsDirectory, providerId);
    throw error;
  }
  output.write(`直接 API Provider 已保存：${nextProvider.name} (${providerId})\n`);
  output.write(`配置文件：${configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { action: existing ? "updated" : "created", provider: nextProvider, configPath };
}

async function removeProvider(options) {
  const provider = await selectProvider(
    options.providers,
    options.prompts,
    "选择要删除的 Provider",
  );
  if (provider === undefined) return { action: "back" };
  const confirmed = await options.prompts.confirm({
    message: `确认删除 ${provider.name} 及其 API Key？`,
    initialValue: false,
  });
  if (options.prompts.isCancel(confirmed) || confirmed !== true) {
    return { action: "back" };
  }
  const previousKey = optionalProviderKey(options.credentialsDirectory, provider.id);
  const previousProviders = options.document.api_providers;
  try {
    removeApiProviderKey(options.credentialsDirectory, provider.id);
    options.document.api_providers = options.providers.filter(
      (candidate) => candidate.id !== provider.id,
    );
    options.writeConfig(options.configPath, options.document);
  } catch (error) {
    options.document.api_providers = previousProviders;
    if (previousKey) writeApiProviderKey(options.credentialsDirectory, provider.id, previousKey);
    throw error;
  }
  options.output.write(`已删除直接 API Provider：${provider.name} (${provider.id})\n`);
  writeGatewayConfigActivationNotice(options.output, options.environment, "restart");
  return { action: "removed", provider: provider.id, configPath: options.configPath };
}

async function selectProvider(providers, prompts, message) {
  const selected = await prompts.select({
    message,
    showInstructions: false,
    options: [
      ...providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        hint: provider.id,
      })),
      { value: "back", label: "返回", hint: "返回直接 API Provider 操作" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return undefined;
  const provider = providers.find((candidate) => candidate.id === selected);
  if (!provider) throw new Error("找不到直接 API Provider");
  return provider;
}

function providerList(value) {
  return Array.isArray(value) ? value.map((candidate) => {
    const provider = table(candidate);
    return {
      id: normalizedProviderId(provider.id),
      name: normalizedProviderName(provider.name),
      protocol: "responses",
      endpoint: normalizedEndpoint(provider.endpoint),
    };
  }) : [];
}

function optionalProviderKey(credentialsDirectory, providerId) {
  try {
    return readApiProviderKey(credentialsDirectory, providerId);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateProviderId(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(stringValue(value))
    ? undefined
    : "请输入 1–64 位小写字母、数字、- 或 _，且以字母或数字开头";
}

function normalizedProviderId(value) {
  const normalized = stringValue(value);
  const error = validateProviderId(normalized);
  if (error) throw new Error(error);
  return normalized;
}

function validateProviderName(value) {
  const normalized = stringValue(value);
  return normalized.length > 0 && normalized.length <= 64
    ? undefined
    : "显示名称长度必须为 1–64 个字符";
}

function normalizedProviderName(value) {
  const normalized = stringValue(value);
  const error = validateProviderName(normalized);
  if (error) throw new Error(error);
  return normalized;
}

function validateEndpoint(value) {
  try {
    normalizedEndpoint(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
