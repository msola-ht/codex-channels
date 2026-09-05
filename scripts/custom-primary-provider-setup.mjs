import * as clackPrompts from "@clack/prompts";

import {
  loadConfiguredCustomSwitchingModelProviders,
  listCustomPrimaryProviderCandidates,
  readPrimaryProviderBackup,
  validateCustomPrimaryModelProviderId,
} from "../runtime/model-provider-runtime.mjs";
import {
  createCodexUserConfigClient,
} from "./codex-user-config.mjs";
import {
  customPrimaryProviderIdFromBaseUrl,
  customPrimaryProviderUrlsShareOrigin,
  prepareCustomPrimaryProviderSave,
  primaryProviderId,
  validCustomPrimaryProviderBaseUrl,
} from "./custom-primary-provider-management.mjs";
import { assertThirdPartyRoleDoesNotUseProvider } from "./agents.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export { primaryProviderId };

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

function modeOptions() {
  return [
    {
      value: "switching",
      label: "OpenAI + 自定义切换模式",
      hint: "保留官方主实例；独立 App Server，可在渠道 /model 中选择",
    },
    {
      value: "exclusive",
      label: "仅自定义固定模式",
      hint: "自定义 Provider 直接作为主 App Server",
    },
  ];
}

export async function runCustomPrimaryProviderSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  allowBack = false,
  createClient = createCodexUserConfigClient,
  providerId: editingProviderId,
} = {}) {
  const client = await createClient({ environment });
  let snapshot;
  let officialModels;
  try {
    await client.connect();
    [snapshot, officialModels] = await Promise.all([
      client.readUserConfigSnapshot(),
      client.listModels(),
    ]);
  } finally {
    await client.close().catch(() => undefined);
  }
  const config = record(snapshot.config);
  const officialModelIds = new Set(
    officialModels.filter((candidate) => candidate.available !== false)
      .map((candidate) => candidate.model),
  );
  if (officialModelIds.size === 0) {
    throw new Error("Codex App Server 没有返回可用的官方模型");
  }
  const activeProviderId = optionalString(config.model_provider);
  const switchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const currentProviders = record(config.model_providers);
  const configuredProviderIds = listCustomPrimaryProviderCandidates(currentProviders, environment);
  const effectiveActiveProviderId = activeProviderId
    ?? (configuredProviderIds.length === 1 ? configuredProviderIds[0] : undefined);
  const currentMainLabel = effectiveActiveProviderId === undefined
    || effectiveActiveProviderId === "openai"
    ? "OpenAI 官方"
    : effectiveActiveProviderId;
  const hasOfficialMainProvider = effectiveActiveProviderId === undefined
    || effectiveActiveProviderId === "openai";
  const hasCustomFixedMainProvider = effectiveActiveProviderId !== undefined
    && configuredProviderIds.includes(effectiveActiveProviderId);
  const fixedProviderId = optionalString(editingProviderId);
  let fixedProvider;
  let fixedProviderFromConfig = false;
  if (fixedProviderId !== undefined) {
    const validationError = validateCustomPrimaryModelProviderId(fixedProviderId, environment);
    const switchingCandidate = switchingProviders.find(({ id }) => id === fixedProviderId);
    const configured = Object.prototype.hasOwnProperty.call(currentProviders, fixedProviderId);
    fixedProviderFromConfig = switchingCandidate === undefined && configured;
    fixedProvider = record(
      switchingCandidate === undefined
        ? configured
          ? currentProviders[fixedProviderId]
          : readPrimaryProviderBackup(environment)[fixedProviderId]
        : {
            name: switchingCandidate.name,
            base_url: switchingCandidate.baseUrl,
            wire_api: "responses",
            supports_websockets: switchingCandidate.supportsWebsockets,
            experimental_bearer_token: switchingCandidate.apiKey,
          },
    );
    if (
      validationError !== null
      || typeof fixedProvider.base_url !== "string"
      || fixedProvider.wire_api !== "responses"
    ) {
      throw new Error(`未找到可编辑的自定义主 Provider：${fixedProviderId}`);
    }
  }
  const switchingProvider = switchingProviders.find(({ id }) => id === fixedProviderId);
  const currentProvider = fixedProviderId === undefined
    ? {}
    : fixedProvider;
  const currentModel = switchingProvider !== undefined && switchingProvider.id === fixedProviderId
    ? switchingProvider.model
    : activeProviderId === fixedProviderId
      ? optionalString(config.model)
      : undefined;
  const currentBaseUrl = optionalString(currentProvider?.base_url) ?? "";
  const currentName = optionalString(currentProvider?.name) ?? "";
  const hasCurrentBearerToken = optionalString(
    currentProvider?.experimental_bearer_token,
  ) !== undefined;
  const hasTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  const currentWebsockets = currentProvider?.supports_websockets === true ? "yes" : "no";

  output.write("\nCodex Connect 自定义 Responses Provider Setup\n\n");
  output.write(`当前主实例：${currentMainLabel}\n`);
  output.write(fixedProviderId === undefined
    ? "当前操作：新增 Provider\n"
    : `当前操作：编辑 ${fixedProviderId}\n`);
  if (fixedProviderId !== undefined) {
    output.write(`当前上游：${currentBaseUrl}\n`);
  }

  const baseUrl = await prompts.text({
    message: "上游 base_url（例如 https://api.example.com/v1）",
    initialValue: currentBaseUrl,
    validate: (value) => {
      const normalized = String(value).trim();
      if (normalized === "") {
        return "base_url 不能为空";
      }
      try {
        validCustomPrimaryProviderBaseUrl(normalized);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(baseUrl) || baseUrl === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedBaseUrl = validCustomPrimaryProviderBaseUrl(String(baseUrl).trim());
  let normalizedId = fixedProviderId;
  if (normalizedId === undefined) {
    const derivedProviderId = customPrimaryProviderIdFromBaseUrl(normalizedBaseUrl);
    const providerId = await prompts.select({
      message: "Provider ID",
      options: [
        {
          value: derivedProviderId,
          label: derivedProviderId,
          hint: "从上游 URL 主机名提取",
        },
        {
          value: primaryProviderId,
          label: `${primaryProviderId}（推荐；允许 Codex 使用远程压缩）`,
          hint: "上游仍需兼容远程压缩接口",
        },
        {
          value: "__custom__",
          label: "自定义标识符",
          hint: "不使用上游地址作为 Provider ID",
        },
      ],
      initialValue: activeProviderId === derivedProviderId ? derivedProviderId : primaryProviderId,
    });
    if (prompts.isCancel(providerId) || providerId === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    if (providerId === "__custom__") {
      const customId = await prompts.text({
        message: "自定义 Provider ID",
        validate: (value) => validateCustomPrimaryModelProviderId(String(value).trim(), environment)
          ?? undefined,
      });
      if (prompts.isCancel(customId) || customId === "back") {
        return { action: allowBack ? "back" : "cancel" };
      }
      normalizedId = String(customId).trim();
    } else {
      normalizedId = String(providerId);
    }
    if (normalizedId === "") return { action: allowBack ? "back" : "cancel" };
    const customIdValidationError = validateCustomPrimaryModelProviderId(normalizedId, environment);
    if (customIdValidationError !== null) throw new Error(customIdValidationError);
    const configured = Object.prototype.hasOwnProperty.call(currentProviders, normalizedId)
      || switchingProviders.some(({ id }) => id === normalizedId);
    const backedUp = !configured
      && Object.prototype.hasOwnProperty.call(
        readPrimaryProviderBackup(environment),
        normalizedId,
      );
    if (configured || backedUp) {
      output.write(`Provider ID ${normalizedId} 已存在，请使用“编辑”。\n`);
      return undefined;
    }
  }

  let normalizedName = primaryProviderId;
  if (normalizedId !== primaryProviderId) {
    const name = await prompts.text({
      message: "显示名称",
      initialValue: currentName || normalizedId,
      validate: (value) => String(value).trim() === "" ? "显示名称不能为空" : undefined,
    });
    if (prompts.isCancel(name) || name === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    normalizedName = String(name).trim();
  }

  const mode = await prompts.select({
    message: "运行模式",
    options: modeOptions(),
    initialValue: switchingProvider?.id === normalizedId
      || (fixedProviderId === undefined && hasOfficialMainProvider)
      ? "switching"
      : "exclusive",
  });
  if (prompts.isCancel(mode) || mode === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  if (
    mode === "switching"
    && effectiveActiveProviderId !== undefined
    && effectiveActiveProviderId !== "openai"
  ) {
    throw new Error(
      `当前固定主 Provider ${effectiveActiveProviderId} 必须先切回官方 OpenAI，才能启用自定义切换模式`,
    );
  }
  if (mode === "switching" && fixedProviderFromConfig) {
    throw new Error(
      "自定义切换模式不修改主配置；请先运行 codexc primary-provider switch openai 将主配置候选移入私有备份，再重新编辑",
    );
  }
  if (mode === "exclusive") {
    if (
      hasCustomFixedMainProvider
      && effectiveActiveProviderId !== normalizedId
    ) {
      assertThirdPartyRoleDoesNotUseProvider(effectiveActiveProviderId, environment);
    }
    if (!hasOfficialMainProvider && !hasCustomFixedMainProvider) {
      throw new Error(
        `当前受管固定 Provider ${effectiveActiveProviderId} 必须先恢复官方模式，才能配置自定义固定 Provider`,
      );
    }
    const otherSwitchingProviderIds = switchingProviders
      .map(({ id }) => id)
      .filter((id) => id !== normalizedId);
    if (otherSwitchingProviderIds.length > 0) {
      throw new Error(
        `固定模式不能保留其他自定义切换 Provider；请先删除其他自定义切换 Provider：${otherSwitchingProviderIds.join("、")}`,
      );
    }
  }

  if (mode === "switching" && hasTopLevelBaseUrl) {
    throw new Error(
      "自定义切换模式不会修改主配置；请先移除主配置中的 openai_base_url",
    );
  }
  const removesTopLevelBaseUrl = mode === "exclusive" && hasTopLevelBaseUrl;
  if (removesTopLevelBaseUrl) {
    output.write(
      "检测到顶层 openai_base_url：固定模式写入前必须移除该旧地址。\n",
    );
    const removeConfirmed = await prompts.confirm({
      message: "是否移除顶层 openai_base_url？",
      initialValue: true,
    });
    if (prompts.isCancel(removeConfirmed) || removeConfirmed !== true) {
      output.write("已取消，未修改配置。\n");
      return undefined;
    }
  }

  const model = await prompts.text({
    message: "上游模型 ID（必须存在于 Codex 官方模型目录）",
    initialValue: currentModel ?? "",
    validate: (value) => {
      const normalized = String(value).trim();
      if (normalized === "") return "模型 ID 不能为空";
      return officialModelIds.has(normalized)
        ? undefined
        : "模型 ID 不在 Codex 官方模型目录中";
    },
  });
  if (prompts.isCancel(model) || model === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedModel = String(model).trim();
  if (!officialModelIds.has(normalizedModel)) {
    throw new Error(`模型 ID 不在 Codex 官方模型目录中：${normalizedModel}`);
  }

  const canPreserveCurrentBearerToken = hasCurrentBearerToken
    && customPrimaryProviderUrlsShareOrigin(currentBaseUrl, normalizedBaseUrl);
  const bearerTokenInput = await prompts.password({
    message: canPreserveCurrentBearerToken
      ? "API Key（留空保留当前 Key；不回显）"
      : mode === "switching"
        ? `API Key（明文写入 0600 的 ~/.codex/sf-custom-${normalizedId}.config.toml；不回显）`
        : "API Key（明文写入 0600 的 ~/.codex/config.toml；不回显）",
    validate: (value) => String(value).trim() === "" && !canPreserveCurrentBearerToken
      ? "API Key 不能为空"
      : undefined,
  });
  if (prompts.isCancel(bearerTokenInput) || bearerTokenInput === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const replacementApiKey = String(bearerTokenInput).trim();
  if (replacementApiKey === "" && !canPreserveCurrentBearerToken) {
    throw new Error("API Key 不能为空");
  }

  const websockets = await prompts.select({
    message: "上游是否支持 Responses WebSocket？",
    options: websocketOptions(),
    initialValue: currentWebsockets,
  });
  if (prompts.isCancel(websockets) || websockets === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }

  const supportsWebsockets = websockets === "yes";
  const saveInput = {
    operation: fixedProviderId === undefined ? "create" : "update",
    providerId: normalizedId,
    name: normalizedName,
    baseUrl: normalizedBaseUrl,
    mode,
    model: normalizedModel,
    supportsWebsockets,
    credential: replacementApiKey === ""
      ? { action: "preserve" }
      : { action: "replace", apiKey: replacementApiKey },
    confirmRemoveTopLevelBaseUrl: removesTopLevelBaseUrl,
  };
  const prepared = await prepareCustomPrimaryProviderSave(saveInput, {
    environment,
    createClient,
    loadContext: async () => ({ snapshot, officialModels }),
  });
  const preview = prepared.preview;
  output.write(preview.provider.mode === "switching"
    ? `\n将写入 ~/.codex/sf-custom-${normalizedId}.config.toml：\n`
    : "\n将写入 ~/.codex/config.toml：\n");
  const previewLines = [
    `- Provider ID：${preview.provider.id}`,
    `- 显示名称：${preview.provider.displayName}`,
    `- 上游：${preview.provider.baseUrl}`,
    `- 默认模型：${preview.provider.model}`,
    `- 运行模式：${preview.provider.mode === "switching" ? "OpenAI + 自定义切换" : "仅自定义固定"}`,
    "- 模型目录：Codex 官方",
    ...(preview.provider.mode === "switching"
      ? [
          "- 主配置：保持官方 OpenAI",
          "- 默认思考等级：medium",
          "- 服务层级：default",
          "- 认证：API Key 将明文写入 0600 私有 Profile（不回显、不进入命令行和日志）",
        ]
      : [
          "- 主配置：写入并启用该固定 Provider",
          "- 认证：API Key 将明文写入 0600 主配置（不回显、不进入命令行和日志）",
        ]),
    `- WebSocket：${preview.provider.supportsWebsockets ? "是" : "否"}`,
  ];
  if (preview.provider.id === primaryProviderId) {
    previewLines.push("- 远程压缩：允许 Codex 使用；上游必须兼容对应接口");
  }
  output.write(previewLines.map((line) => `${line}\n`).join(""));

  const confirmed = await prompts.confirm({
    message: "确认写入？",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改配置。\n");
    return undefined;
  }

  const result = await prepared.apply();
  const backupCleanupFailed = result.warnings.some(
    ({ code }) => code === "backup-cleanup-failed",
  );
  if (result.provider.mode === "switching") {
    output.write(
      backupCleanupFailed
        ? `配置已写入，但自定义主 Provider ${result.provider.id} 的私有备份清理失败；`
          + "请修复私有备份权限后重试切换或删除。\n"
        : "配置已写入。\n",
    );
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
    output.write(
      "旧 Thread 不会改变；重启后，在 /model 选择该 Provider，"
      + "下一条消息会创建新的 Provider Thread。可用 /model clear 清除会话偏好。\n",
    );
    return {
      provider: result.provider.id,
      model: result.provider.model,
      activation: "restart-all",
      activationResult: configActivationResult("restart-all"),
    };
  }
  output.write(
    backupCleanupFailed
      ? `配置已写入，但自定义主 Provider ${result.provider.id} 的私有备份清理失败；`
        + "请修复私有备份权限后重试切换或删除。\n"
      : "配置已写入。\n",
  );
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  output.write(
    "旧 Thread 不会改变；重启后新 Thread 使用该固定 Provider。"
    + "会话内 /model 偏好可用 /model clear 清除。\n",
  );
  return {
    provider: result.provider.id,
    model: result.provider.model,
    activation: "restart-all",
    activationResult: configActivationResult("restart-all"),
  };
}
