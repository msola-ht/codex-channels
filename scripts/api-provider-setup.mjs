import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  deleteApiProvider,
  listApiProviders,
  saveApiProvider,
  validateApiProviderEndpoint,
  validateApiProviderId,
  validateApiProviderName,
} from "./api-provider-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export async function runApiProviderSetup({
  environment = process.env,
  output = process.stdout,
  prompts,
  writeConfig = writeGatewayConfig,
} = {}) {
  if (!prompts) throw new Error("第三方 API Setup 缺少交互实现");
  const { configPath, providers } = listApiProviders(environment);
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
      validate: (value) => validateApiProviderId(value)
        ?? (providers.some((provider) => provider.id === stringValue(value))
          ? "Provider ID 已存在，请使用“编辑 Provider”"
          : undefined),
    });
    if (prompts.isCancel(id)) return { action: "back" };
    const validationError = validateApiProviderId(id);
    if (validationError !== undefined) throw new Error(validationError);
    providerId = stringValue(id);
    if (providers.some((provider) => provider.id === providerId)) {
      throw new Error("Provider ID 已存在，请使用“编辑 Provider”");
    }
  }
  const name = await prompts.text({
    message: "显示名称",
    initialValue: existing?.name ?? providerId,
    validate: validateApiProviderName,
  });
  if (prompts.isCancel(name)) return { action: "back" };
  const endpoint = await prompts.text({
    message: "Responses API 地址",
    initialValue: existing?.endpoint ?? "",
    validate: validateApiProviderEndpoint,
  });
  if (prompts.isCancel(endpoint)) return { action: "back" };
  const apiKey = await prompts.password({
    message: existing?.hasApiKey
      ? "API Key（留空保留当前 Key）"
      : "API Key",
    validate: (value) => existing?.hasApiKey || stringValue(value)
      ? undefined
      : "API Key 不能为空",
  });
  if (prompts.isCancel(apiKey)) return { action: "back" };
  const result = saveApiProvider({
    operation: existing === undefined ? "create" : "update",
    id: providerId,
    name,
    endpoint,
    ...(stringValue(apiKey) === "" ? {} : { apiKey }),
  }, { environment, writeConfig });
  output.write(`直接 API Provider 已保存：${result.provider.name} (${providerId})\n`);
  output.write(`配置文件：${configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-gateway"));
  return result;
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
  const result = deleteApiProvider(provider.id, {
    environment: options.environment,
    writeConfig: options.writeConfig,
  });
  options.output.write(`已删除直接 API Provider：${provider.name} (${provider.id})\n`);
  writeGatewayConfigActivationNotice(
    options.output,
    options.environment,
    configActivationResult("restart-gateway"),
  );
  return result;
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

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
