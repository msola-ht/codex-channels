import * as clackPrompts from "@clack/prompts";
import { isIP } from "node:net";

import {
  loadConfiguredCustomSwitchingModelProviders,
  listCustomPrimaryProviderCandidates,
  readPrimaryProviderBackup,
  removeCustomPrimaryProviderSwitchingProfile,
  removePrimaryProviderBackupCandidate,
  restoreCustomPrimaryProviderSwitchingProfile,
  validProviderBaseUrl,
  validateCustomPrimaryModelProviderId,
  writeCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import {
  createCustomPrimaryProviderConfig,
  modelProviderBlockEdits,
} from "../runtime/model-provider-profile.mjs";
import {
  areCodexUserConfigEditsApplied,
  createCodexUserConfigClient,
  readCodexUserConfigSnapshot,
} from "./codex-user-config.mjs";
import { assertThirdPartyRoleDoesNotUseProvider } from "./agents.mjs";

export const primaryProviderId = "OpenAI";

function providerIdFromBaseUrl(baseUrl) {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  const id = hostname
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);
  const validationError = validateCustomPrimaryModelProviderId(id);
  if (validationError !== null) {
    throw new Error(`无法从 URL 提取 Provider ID：${validationError}`);
  }
  return id;
}

function validSetupProviderBaseUrl(value) {
  const normalized = validProviderBaseUrl(value, "自定义主 Provider");
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase();
  const address = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const addressFamily = isIP(address);
  const isLoopback = hostname === "localhost"
    || (addressFamily === 4 && address.startsWith("127."))
    || (addressFamily === 6 && address === "::1");
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("自定义主 Provider 远程地址必须使用 HTTPS；HTTP 仅限本机回环地址");
  }
  return normalized;
}

function sameUrlOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

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
  let fixedProviderFromBackup = false;
  let fixedProviderFromConfig = false;
  if (fixedProviderId !== undefined) {
    const validationError = validateCustomPrimaryModelProviderId(fixedProviderId, environment);
    const switchingCandidate = switchingProviders.find(({ id }) => id === fixedProviderId);
    const configured = Object.prototype.hasOwnProperty.call(currentProviders, fixedProviderId);
    fixedProviderFromConfig = switchingCandidate === undefined && configured;
    fixedProviderFromBackup = switchingCandidate === undefined && !configured;
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
  const currentBearerToken = optionalString(currentProvider?.experimental_bearer_token);
  const hasCurrentBearerToken = currentBearerToken !== undefined;
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
        validSetupProviderBaseUrl(normalized);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(baseUrl) || baseUrl === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedBaseUrl = validSetupProviderBaseUrl(String(baseUrl).trim());
  let normalizedId = fixedProviderId;
  if (normalizedId === undefined) {
    const derivedProviderId = providerIdFromBaseUrl(normalizedBaseUrl);
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
      ],
      initialValue: activeProviderId === derivedProviderId ? derivedProviderId : primaryProviderId,
    });
    if (prompts.isCancel(providerId) || providerId === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    normalizedId = String(providerId);
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
    && sameUrlOrigin(currentBaseUrl, normalizedBaseUrl);
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
  const bearerToken = String(bearerTokenInput).trim()
    || (canPreserveCurrentBearerToken ? currentBearerToken : undefined);
  if (bearerToken === undefined) {
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
  const providerBlock = createCustomPrimaryProviderConfig({
    name: normalizedName,
    baseUrl: normalizedBaseUrl,
    auth: "bearer_token",
    bearerToken,
    supportsWebsockets,
  });
  output.write(mode === "switching"
    ? `\n将写入 ~/.codex/sf-custom-${normalizedId}.config.toml：\n`
    : "\n将写入 ~/.codex/config.toml：\n");
  const previewLines = [
    `- Provider ID：${normalizedId}`,
    `- 显示名称：${normalizedName}`,
    `- 上游：${normalizedBaseUrl}`,
    `- 默认模型：${normalizedModel}`,
    `- 运行模式：${mode === "switching" ? "OpenAI + 自定义切换" : "仅自定义固定"}`,
    "- 模型目录：Codex 官方",
    ...(mode === "switching"
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
    `- WebSocket：${supportsWebsockets ? "是" : "否"}`,
  ];
  if (normalizedId === primaryProviderId) {
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

  const switching = mode === "switching";
  if (switching) {
    writeCustomPrimaryProviderSwitchingProfile({
      provider: normalizedId,
      model: normalizedModel,
      name: normalizedName,
      baseUrl: normalizedBaseUrl,
      apiKey: bearerToken,
      supportsWebsockets,
      catalogSource: { kind: "official" },
    }, environment);
    let backupCleanupFailed = false;
    if (fixedProviderId !== undefined && fixedProviderFromBackup) {
      try {
        removePrimaryProviderBackupCandidate(fixedProviderId, environment);
      } catch {
        backupCleanupFailed = true;
      }
    }
    output.write(
      backupCleanupFailed
        ? `配置已写入，但自定义主 Provider ${fixedProviderId} 的私有备份清理失败；`
          + "请修复私有备份权限后重试切换或删除。请运行 codexc service restart all 生效。\n"
        : "配置已写入。请运行 codexc service restart all 生效。\n",
    );
    output.write(
      "旧 Thread 不会改变；重启后，在 /model 选择该 Provider，"
      + "下一条消息会创建新的 Provider Thread。可用 /model clear 清除会话偏好。\n",
    );
    return { provider: normalizedId, model: normalizedModel };
  }
  const edits = [
    ...(removesTopLevelBaseUrl
      ? [{ keyPath: "openai_base_url", value: null }]
      : []),
    { keyPath: "model_provider", value: normalizedId },
    { keyPath: "model", value: normalizedModel },
    ...modelProviderBlockEdits(normalizedId, providerBlock),
  ];
  const writer = await createClient({ environment });
  try {
    await writer.connect();
    removeCustomPrimaryProviderSwitchingProfile(
      environment,
      normalizedId,
      switchingProvider?.profileContent,
    );
    try {
      await writer.writeUserConfigEdits(edits, { expectedVersion: snapshot.version });
    } catch (error) {
      let applied;
      let currentProvider;
      try {
        const currentConfig = (await readCodexUserConfigSnapshot(environment, { createClient }))
          .config;
        applied = areCodexUserConfigEditsApplied(currentConfig, edits);
        currentProvider = optionalString(currentConfig.model_provider);
      } catch (confirmationError) {
        // 写入状态未知时不能恢复 Profile，否则可能同时激活固定和切换模式。
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error, confirmationError],
          "Codex 配置写入结果无法确认，自定义切换 Provider Profile 保持移除",
        );
      }
      if (!applied) {
        if (
          switchingProvider !== undefined
          && (currentProvider === undefined || currentProvider === "openai")
        ) {
          try {
            restoreCustomPrimaryProviderSwitchingProfile(
              environment,
              switchingProvider.id,
              switchingProvider.profileContent,
            );
          } catch (rollbackError) {
            // AggregateError 已保留配置写入与 Profile 回滚两个原始错误。
            // eslint-disable-next-line preserve-caught-error
            throw new AggregateError(
              [error, rollbackError],
              "Codex 配置写入失败，且自定义切换 Provider Profile 回滚失败",
            );
          }
        }
        throw error;
      }
    }
  } finally {
    await writer.close().catch(() => undefined);
  }
  let backupCleanupFailed = false;
  if (fixedProviderId !== undefined && fixedProviderFromBackup) {
    try {
      removePrimaryProviderBackupCandidate(fixedProviderId, environment);
    } catch {
      backupCleanupFailed = true;
    }
  }
  output.write(
    backupCleanupFailed
      ? `配置已写入，但自定义主 Provider ${fixedProviderId} 的私有备份清理失败；`
        + "请修复私有备份权限后重试切换或删除。请运行 codexc service restart all 生效。\n"
      : "配置已写入。请运行 codexc service restart all 生效。\n",
  );
  output.write(
    "旧 Thread 不会改变；重启后新 Thread 使用该固定 Provider。"
    + "会话内 /model 偏好可用 /model clear 清除。\n",
  );
  return { provider: normalizedId, model: normalizedModel };
}
