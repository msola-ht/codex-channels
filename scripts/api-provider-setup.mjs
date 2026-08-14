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
import {
  readVisionApiKey,
  removeVisionApiKey,
} from "../runtime/vision-credential.mjs";
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
  const legacyVision = legacyVisionConfig(document.vision);
  const action = await prompts.select({
    message: "第三方 API 提供商",
    showInstructions: false,
    options: [
      { value: "upsert", label: "添加或更新", hint: "Responses 兼容接口与独立 API Key" },
      ...(providers.length > 0
        ? [{ value: "remove", label: "删除提供商", hint: "同时删除该提供商凭据" }]
        : []),
      { value: "back", label: "返回上一级" },
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
    });
  }
  if (action !== "upsert") throw new Error(`未知第三方 API 操作：${String(action)}`);

  const id = await prompts.text({
    message: "提供商 ID（小写字母、数字、-、_）",
    validate: validateProviderId,
  });
  if (prompts.isCancel(id)) return { action: "back" };
  const providerId = normalizedProviderId(id);
  const existing = providers.find((provider) => provider.id === providerId);
  const name = await prompts.text({
    message: "显示名称",
    initialValue: existing?.name ?? providerId,
    validate: validateProviderName,
  });
  if (prompts.isCancel(name)) return { action: "back" };
  const endpoint = await prompts.text({
    message: "Responses API 地址",
    initialValue: existing?.endpoint ?? legacyVision?.endpoint ?? "",
    validate: validateEndpoint,
  });
  if (prompts.isCancel(endpoint)) return { action: "back" };
  const existingProviderKey = optionalProviderKey(credentialsDirectory, providerId);
  const migrateLegacyVision = legacyVision !== undefined
    && await prompts.confirm(
      "检测到旧的单视觉 API 配置，是否同时改为使用这个提供商？",
      true,
    );
  const retainedKey = existingProviderKey
    ?? (migrateLegacyVision ? optionalVisionKey(credentialsDirectory) : undefined);
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
    if (migrateLegacyVision) {
      document.vision = {
        mode: "responses_api",
        provider: providerId,
        model: legacyVision.model,
      };
    }
    writeConfig(configPath, document);
  } catch (error) {
    document.api_providers = previousProviders;
    if (existingProviderKey) {
      writeApiProviderKey(credentialsDirectory, providerId, existingProviderKey);
    }
    else removeApiProviderKey(credentialsDirectory, providerId);
    throw error;
  }
  if (migrateLegacyVision) {
    try {
      removeVisionApiKey(credentialsDirectory);
    } catch {
      output.write("旧视觉凭据未能清理；新提供商已生效，请稍后检查 credentials/vision。\n");
    }
  }
  output.write(`第三方 API 提供商已保存：${nextProvider.name} (${providerId})\n`);
  output.write(`配置文件：${configPath}\n`);
  writeGatewayConfigActivationNotice(output);
  return { action: existing ? "updated" : "created", provider: nextProvider, configPath };
}

async function removeProvider(options) {
  const selected = await options.prompts.select({
    message: "选择要删除的提供商",
    showInstructions: false,
    options: [
      ...options.providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        hint: provider.id,
      })),
      { value: "back", label: "返回上一级" },
    ],
  });
  if (options.prompts.isCancel(selected) || selected === "back") return { action: "back" };
  const provider = options.providers.find((candidate) => candidate.id === selected);
  if (!provider) throw new Error("找不到第三方 API 提供商");
  if (table(options.document.vision).provider === provider.id) {
    throw new Error(`第三方 API 提供商仍被 vision 使用：${provider.id}`);
  }
  if (!await options.prompts.confirm(`确认删除 ${provider.name} 及其 API Key？`, false)) {
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
  options.output.write(`已删除第三方 API 提供商：${provider.name} (${provider.id})\n`);
  writeGatewayConfigActivationNotice(options.output);
  return { action: "removed", provider: provider.id, configPath: options.configPath };
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

function optionalVisionKey(credentialsDirectory) {
  try {
    return readVisionApiKey(credentialsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function legacyVisionConfig(value) {
  const vision = table(value);
  return vision.mode === "responses_api"
    && typeof vision.endpoint === "string"
    && typeof vision.model === "string"
    && typeof vision.provider !== "string"
    ? { endpoint: vision.endpoint, model: vision.model }
    : undefined;
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
