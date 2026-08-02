import { join } from "node:path";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  readVisionApiKey,
  removeVisionApiKey,
  writeVisionApiKey,
} from "../runtime/vision-credential.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runVisionSetup({
  environment = process.env,
  output = process.stdout,
  prompts,
  writeConfig = writeGatewayConfig,
} = {}) {
  if (!prompts) throw new Error("视觉 Setup 缺少交互实现");
  const { configPath, dataDir } = requireUserConfig(environment);
  const credentialsDirectory = join(dataDir, "credentials");
  const document = readGatewayConfig(configPath);
  const existing = table(document.vision);
  const selected = await prompts.select({
    message: "选择图片识别方式",
    showInstructions: false,
    options: [
      {
        value: "responses_api",
        label: "外部视觉 API",
        hint: "模型不支持图片时使用；需要 Responses 兼容接口和 API Key",
      },
      { value: "disabled", label: "禁用图片识别" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  const next = selected === "responses_api"
    ? await responsesConfig(prompts, existing, credentialsDirectory)
    : selected === "disabled"
      ? { config: { mode: "disabled" }, apiKey: undefined }
      : unknownSelection(selected);
  if (!next) return { action: "back" };

  const previousApiKey = optionalVisionApiKey(credentialsDirectory);
  try {
    if (next.apiKey) writeVisionApiKey(credentialsDirectory, next.apiKey);
    else removeVisionApiKey(credentialsDirectory);
    document.vision = next.config;
    writeConfig(configPath, document);
  } catch (error) {
    if (previousApiKey) writeVisionApiKey(credentialsDirectory, previousApiKey);
    else removeVisionApiKey(credentialsDirectory);
    throw error;
  }

  output.write(`图片识别配置已保存：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { mode: next.config.mode, configPath };
}

async function responsesConfig(prompts, existing, credentialsDirectory) {
  const endpoint = await prompts.text({
    message: "视觉 Responses API 地址",
    initialValue: existing.mode === "responses_api" ? stringValue(existing.endpoint) : "",
    validate: (value) => validateEndpoint(value),
  });
  if (prompts.isCancel(endpoint)) return undefined;
  const endpointError = validateEndpoint(endpoint);
  if (endpointError) throw new Error(endpointError);
  const model = await prompts.text({
    message: "视觉模型 ID",
    initialValue: existing.mode === "responses_api" ? stringValue(existing.model) : "",
    validate: (value) => stringValue(value) ? undefined : "模型 ID 不能为空",
  });
  if (prompts.isCancel(model)) return undefined;
  if (!stringValue(model)) throw new Error("模型 ID 不能为空");
  const hasCredential = optionalVisionApiKey(credentialsDirectory) !== undefined;
  const apiKey = await prompts.password({
    message: hasCredential
      ? "视觉 API Key（留空保留当前 Key）"
      : "视觉 API Key",
    validate: (value) => hasCredential || stringValue(value)
      ? undefined
      : "API Key 不能为空",
  });
  if (prompts.isCancel(apiKey)) return undefined;
  return {
    config: {
      mode: "responses_api",
      endpoint: stringValue(endpoint),
      model: stringValue(model),
    },
    apiKey: stringValue(apiKey) || optionalVisionApiKey(credentialsDirectory),
  };
}

function optionalVisionApiKey(credentialsDirectory) {
  try {
    return readVisionApiKey(credentialsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(stringValue(value));
  } catch {
    return "请输入有效 URL";
  }
  const loopback = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    return "必须使用 HTTPS；本机回环地址可以使用 HTTP";
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    return "地址不能包含凭据或 Fragment";
  }
  return undefined;
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unknownSelection(value) {
  throw new Error(`未知图片识别方式：${String(value)}`);
}
