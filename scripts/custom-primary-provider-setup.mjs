import * as clackPrompts from "@clack/prompts";

import {
  listCustomPrimaryProviderCandidates,
  validateCustomPrimaryModelProviderId,
  validProviderBaseUrl,
} from "../runtime/model-provider-runtime.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function authOptions() {
  return [
    {
      value: "apikey",
      label: "使用当前 API Key",
      hint: "requires_openai_auth = true",
    },
    {
      value: "env_key",
      label: "环境变量密钥",
      hint: "通过 env_key 指定环境变量名",
    },
    {
      value: "none",
      label: "无认证",
      hint: "requires_openai_auth = false",
    },
  ];
}

function websocketOptions() {
  return [
    {
      value: "no",
      label: "否（推荐）",
      hint: "supports_websockets = false，走 HTTPS",
    },
    {
      value: "yes",
      label: "是",
      hint: "supports_websockets = true",
    },
  ];
}

export async function runCustomPrimaryProviderSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  allowBack = false,
  createClient = createCodexUserConfigClient,
} = {}) {
  const client = await createClient({ environment });
  let snapshot;
  try {
    await client.connect();
    snapshot = await client.readUserConfigSnapshot();
  } finally {
    await client.close().catch(() => undefined);
  }
  const config = record(snapshot.config);
  const currentProviderId = optionalString(config.model_provider);
  const currentProviders = record(config.model_providers);
  const currentProvider = currentProviderId === undefined
    ? undefined
    : record(currentProviders[currentProviderId]);
  const currentModel = optionalString(config.model);
  const currentBaseUrl = optionalString(currentProvider?.base_url) ?? "";
  const currentName = optionalString(currentProvider?.name) ?? "";
  const currentEnvKey = optionalString(currentProvider?.env_key) ?? "";
  const hasTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  const currentAuth = currentProvider?.requires_openai_auth === false
    ? "none"
    : optionalString(currentProvider?.env_key) !== undefined
      ? "env_key"
      : "apikey";
  const currentWebsockets = currentProvider?.supports_websockets === true ? "yes" : "no";

  output.write("\nCodex Connect 自定义主 Provider Setup\n\n");
  output.write(`当前主 Provider：${currentProviderId ?? "未配置"}\n`);
  if (currentProviderId !== undefined) {
    output.write(`当前上游：${currentBaseUrl}\n`);
  }

  const providerId = await prompts.text({
    message: "自定义 Provider ID（例如 OpenAI）",
    initialValue: currentProviderId ?? "OpenAI",
    validate: (value) => validateCustomPrimaryModelProviderId(String(value).trim()),
  });
  if (prompts.isCancel(providerId) || providerId === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedId = String(providerId).trim();
  const reservedError = validateCustomPrimaryModelProviderId(normalizedId);
  if (reservedError !== null) {
    throw new Error(reservedError);
  }

  const baseUrl = await prompts.text({
    message: "上游 base_url（例如 https://zzone.cc.cd/v1）",
    initialValue: currentBaseUrl,
    validate: (value) => {
      const normalized = String(value).trim();
      if (normalized === "") {
        return "base_url 不能为空";
      }
      try {
        validProviderBaseUrl(normalized, "自定义主 Provider");
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(baseUrl) || baseUrl === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedBaseUrl = validProviderBaseUrl(String(baseUrl).trim(), "自定义主 Provider");

  const name = await prompts.text({
    message: "显示名称",
    initialValue: currentName || normalizedId,
    validate: (value) => String(value).trim() === "" ? "显示名称不能为空" : undefined,
  });
  if (prompts.isCancel(name) || name === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedName = String(name).trim();

  const auth = await prompts.select({
    message: "认证方式",
    options: authOptions(),
    initialValue: currentAuth,
  });
  if (prompts.isCancel(auth) || auth === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  let envKey;
  if (auth === "env_key") {
    const suggestedEnvKey = currentEnvKey
      || `CODEX_${normalizedId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_API_KEY`;
    envKey = await prompts.text({
      message: "保存 API Key 的环境变量名",
      initialValue: suggestedEnvKey,
      validate: (value) => {
        const normalized = String(value).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) {
          return "环境变量名无效";
        }
        return undefined;
      },
    });
    if (prompts.isCancel(envKey) || envKey === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
  }

  const websockets = await prompts.select({
    message: "上游是否支持 Responses WebSocket？",
    options: websocketOptions(),
    initialValue: currentWebsockets,
  });
  if (prompts.isCancel(websockets) || websockets === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }

  const model = await prompts.text({
    message: "默认模型（例如 gpt-5.6-sol）",
    initialValue: currentModel ?? "",
    validate: (value) => String(value).trim() === "" ? "默认模型不能为空" : undefined,
  });
  if (prompts.isCancel(model) || model === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedModel = String(model).trim();

  const staleProviderIds = [
    ...listCustomPrimaryProviderCandidates(currentProviders).filter((id) => id !== normalizedId),
    ...(currentProviderId !== undefined
      && currentProviderId !== normalizedId
      && validateCustomPrimaryModelProviderId(currentProviderId) === null
      ? [currentProviderId]
      : []),
  ];
  const uniqueStaleProviderIds = [...new Set(staleProviderIds)];
  const removesTopLevelBaseUrl = hasTopLevelBaseUrl;
  if (uniqueStaleProviderIds.length > 0 || removesTopLevelBaseUrl) {
    output.write(
      `检测到需要清理的官方/旧配置：${
        uniqueStaleProviderIds.length > 0
          ? `自定义主 Provider 块 ${uniqueStaleProviderIds.join("、")}`
          : ""
      }${uniqueStaleProviderIds.length > 0 && removesTopLevelBaseUrl ? "、" : ""}`
      + `${removesTopLevelBaseUrl ? "顶层 openai_base_url" : ""}；`
      + "官方与第三方主 Provider 只能同时存在一个。\n",
    );
    const removeConfirmed = await prompts.confirm({
      message: "是否移除这些旧配置？",
      initialValue: true,
    });
    if (prompts.isCancel(removeConfirmed) || removeConfirmed !== true) {
      output.write("已取消，未修改配置。\n");
      return undefined;
    }
  }

  const requiresOpenAiAuth = auth !== "none";
  const supportsWebsockets = websockets === "yes";
  output.write("\n将写入 ~/.codex/config.toml：\n");
  output.write([
    `- Provider ID：${normalizedId}`,
    `- 显示名称：${normalizedName}`,
    `- 上游：${normalizedBaseUrl}`,
    `- 默认模型：${normalizedModel}`,
    `- 认证：${auth === "none" ? "无" : auth === "env_key" ? `环境变量 ${envKey}` : "当前 API Key"}`,
    `- WebSocket：${supportsWebsockets ? "是" : "否"}`,
  ].map((line) => `${line}\n`).join(""));

  const confirmed = await prompts.confirm({
    message: "确认写入？",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改配置。\n");
    return undefined;
  }

  const edits = [
    ...uniqueStaleProviderIds.map((id) => ({
      keyPath: `model_providers.${id}`,
      value: null,
    })),
    ...(removesTopLevelBaseUrl
      ? [{ keyPath: "openai_base_url", value: null }]
      : []),
    { keyPath: "model_provider", value: normalizedId },
    { keyPath: "model", value: normalizedModel },
    { keyPath: `model_providers.${normalizedId}.name`, value: normalizedName },
    { keyPath: `model_providers.${normalizedId}.base_url`, value: normalizedBaseUrl },
    { keyPath: `model_providers.${normalizedId}.wire_api`, value: "responses" },
    { keyPath: `model_providers.${normalizedId}.requires_openai_auth`, value: requiresOpenAiAuth },
    { keyPath: `model_providers.${normalizedId}.supports_websockets`, value: supportsWebsockets },
    ...(envKey === undefined
      ? []
      : [{ keyPath: `model_providers.${normalizedId}.env_key`, value: envKey }]),
    ...(auth !== "env_key" && currentEnvKey !== ""
      ? [{ keyPath: `model_providers.${normalizedId}.env_key`, value: null }]
      : []),
  ];
  const writer = await createClient({ environment });
  try {
    await writer.connect();
    await writer.writeUserConfigEdits(edits, { expectedVersion: snapshot.version });
  } finally {
    await writer.close().catch(() => undefined);
  }
  output.write("配置已写入。请运行 codexc service restart all 生效。\n");
  output.write(
    "注意：旧会话仍使用创建时的 Provider，请用 /new 创建新会话；"
    + "会话内 /model 偏好可用 /model clear 清除。\n",
  );
  return { provider: normalizedId, model: normalizedModel };
}
