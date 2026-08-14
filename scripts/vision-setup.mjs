import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runVisionSetup({
  environment = process.env,
  output = process.stdout,
  prompts,
  writeConfig = writeGatewayConfig,
} = {}) {
  if (!prompts) throw new Error("视觉 Setup 缺少交互实现");
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const existing = table(document.vision);
  const providers = providerList(document.api_providers);
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
    ? await responsesConfig(prompts, existing, providers)
    : selected === "disabled"
      ? { config: { mode: "disabled" } }
      : unknownSelection(selected);
  if (!next) return { action: "back" };
  document.vision = next.config;
  writeConfig(configPath, document);

  output.write(`图片识别配置已保存：${configPath}\n`);
  writeGatewayConfigActivationNotice(output);
  return { mode: next.config.mode, configPath };
}

async function responsesConfig(prompts, existing, providers) {
  if (providers.length === 0) {
    throw new Error("尚未配置第三方 API 提供商，请先在模型渠道中添加");
  }
  const provider = await prompts.select({
    message: "选择图片识别 API 提供商",
    showInstructions: false,
    initialValue: providers.some((candidate) => candidate.id === existing.provider)
      ? existing.provider
      : undefined,
    options: [
      ...providers.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
        hint: candidate.id,
      })),
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(provider) || provider === "back") return undefined;
  const model = await prompts.text({
    message: "视觉模型 ID",
    initialValue: existing.mode === "responses_api" ? stringValue(existing.model) : "",
    validate: (value) => stringValue(value) ? undefined : "模型 ID 不能为空",
  });
  if (prompts.isCancel(model)) return undefined;
  if (!stringValue(model)) throw new Error("模型 ID 不能为空");
  return {
    config: {
      mode: "responses_api",
      provider: String(provider),
      model: stringValue(model),
    },
  };
}

function providerList(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const provider = table(candidate);
    return typeof provider.id === "string" && typeof provider.name === "string"
      ? [{ id: provider.id, name: provider.name }]
      : [];
  });
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
