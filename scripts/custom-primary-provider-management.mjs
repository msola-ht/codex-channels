import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";

import {
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  readPrimaryProviderBackup,
  removePrimaryProviderBackupCandidate,
  validProviderBaseUrl,
  validateCustomPrimaryModelProviderId,
  writeCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import {
  createCustomPrimaryProviderConfig,
  modelProviderBlockEdits,
} from "../runtime/model-provider-profile.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import {
  writePrimaryProviderConfigEditsWithProfileRemoval,
} from "./primary-provider-config-transaction.mjs";
import { assertThirdPartyRoleDoesNotUseProvider } from "./agents.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { PrimaryProviderManagementError } from "./primary-provider-management.mjs";

export const primaryProviderId = "OpenAI";

export function customPrimaryProviderIdFromBaseUrl(baseUrl) {
  const hostname = new URL(validCustomPrimaryProviderBaseUrl(baseUrl)).hostname.toLowerCase();
  const id = hostname
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);
  const validationError = validateCustomPrimaryModelProviderId(id);
  if (validationError !== null) {
    throw invalid("invalid-provider-id", "providerId", `无法从 URL 提取 Provider ID：${validationError}`);
  }
  return id;
}

export function validCustomPrimaryProviderBaseUrl(value) {
  let normalized;
  try {
    normalized = validProviderBaseUrl(value, "自定义主 Provider");
  } catch (error) {
    throw invalid(
      "invalid-base-url",
      "baseUrl",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase();
  const address = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const addressFamily = isIP(address);
  const isLoopback = hostname === "localhost"
    || (addressFamily === 4 && address.startsWith("127."))
    || (addressFamily === 6 && address === "::1");
  if (url.protocol !== "https:" && !isLoopback) {
    throw invalid(
      "insecure-base-url",
      "baseUrl",
      "自定义主 Provider 远程地址必须使用 HTTPS；HTTP 仅限本机回环地址",
    );
  }
  return normalized;
}

export function customPrimaryProviderUrlsShareOrigin(left, right) {
  return sameUrlOrigin(left, right);
}

export async function previewCustomPrimaryProviderSave(input, options = {}) {
  const plan = await buildSavePlan(input, options, { requireConfirmation: false });
  return publicSavePreview(input, plan);
}

export async function prepareCustomPrimaryProviderSave(input, options = {}) {
  const plan = await buildSavePlan(input, options, { requireConfirmation: true });
  const environment = options.environment ?? process.env;
  return {
    preview: publicSavePreview(input, plan),
    apply: () => withModelProviderManagementTransaction(
      environment,
      () => applySavePlan(input, plan, options),
    ),
  };
}

function publicSavePreview(input, plan) {
  return {
    operation: input.operation,
    provider: plan.provider,
    activation: "restart-all",
    effects: plan.effects,
    credential: {
      action: input.credential.action,
      storedAsPlaintext: true,
      destination: plan.provider.mode === "switching" ? "private-profile" : "main-config",
    },
  };
}

export async function applyCustomPrimaryProviderSave(input, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await buildSavePlan(input, options, { requireConfirmation: true });
    return applySavePlan(input, plan, options);
  });
}

async function applySavePlan(input, plan, options) {
  const { environment = process.env, createClient = createCodexUserConfigClient } = options;
  if (plan.providerIdToDeactivate !== undefined) {
    assertProviderNotInUse(plan.providerIdToDeactivate, environment);
  }
  if (plan.provider.mode === "switching") {
    const client = await createClient({ environment });
    try {
      await client.connect();
      const current = await client.readUserConfigSnapshot();
      if (!isDeepStrictEqual(current.version, plan.expectedVersion)) {
        throw invalid("stale-preview", "operation", "Codex 配置已变化，请重新预览后再保存");
      }
    } finally {
      await client.close().catch(() => undefined);
    }
    try {
      writeCustomPrimaryProviderSwitchingProfile({
        provider: plan.provider.id,
        model: plan.provider.model,
        name: plan.provider.displayName,
        baseUrl: plan.provider.baseUrl,
        apiKey: plan.apiKey,
        supportsWebsockets: plan.provider.supportsWebsockets,
        catalogSource: { kind: "official" },
      }, environment, {
        expectedProfilePresent: plan.switchingProvider !== undefined,
        expectedProfileContent: plan.switchingProvider?.profileContent,
        expectedProviderIds: plan.registeredProviderIds,
      });
    } catch (error) {
      if (error?.code === "CUSTOM_SWITCHING_PROFILE_CHANGED") {
        throw invalid(
          "stale-preview",
          "operation",
          "自定义切换 Provider 已变化，请重新预览后再保存",
          error,
        );
      }
      throw error;
    }
  } else {
    await writePrimaryProviderConfigEditsWithProfileRemoval({
      environment,
      createClient,
      providerId: plan.provider.id,
      switchingProvider: plan.switchingProvider,
      edits: plan.edits,
      expectedVersion: plan.expectedVersion,
    });
  }
  let backupCleaned = true;
  if (plan.backupCandidateToRemove !== undefined) {
    try {
      removePrimaryProviderBackupCandidate(plan.backupCandidateToRemove, environment);
    } catch {
      backupCleaned = false;
    }
  }
  return {
    action: input.operation === "create" ? "created" : "updated",
    provider: plan.provider,
    activation: "restart-all",
    effects: plan.effects,
    warnings: backupCleaned
      ? []
      : [{ code: "backup-cleanup-failed", providerId: plan.provider.id }],
  };
}

async function buildSavePlan(input, options, { requireConfirmation }) {
  if (input?.operation !== "create" && input?.operation !== "update") {
    throw invalid("invalid-operation", "operation", "Provider 保存操作必须是 create 或 update");
  }
  const { environment = process.env } = options;
  const { snapshot, officialModels } = await loadSaveContext(options);
  const config = record(snapshot.config);
  const currentProviders = record(config.model_providers);
  const configuredProviderIds = listCustomPrimaryProviderCandidates(currentProviders, environment);
  const switchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const providerId = normalizeProviderId(input.providerId, environment);
  const switchingProvider = switchingProviders.find(({ id }) => id === providerId);
  const configured = configuredProviderIds.includes(providerId);
  const backup = input.operation === "create" || (!configured && switchingProvider === undefined)
    ? readBackup(environment)
    : {};
  const backedUp = Object.prototype.hasOwnProperty.call(backup, providerId);
  if (input.operation === "create" && (configured || backedUp || switchingProvider !== undefined)) {
    throw invalid("provider-exists", "providerId", `Provider ID ${providerId} 已存在，请使用“编辑”`);
  }
  if (input.operation === "update" && !configured && !backedUp && switchingProvider === undefined) {
    throw invalid("provider-not-found", "providerId", `未找到可编辑的自定义主 Provider：${providerId}`);
  }
  const existing = input.operation === "update"
    ? record(switchingProvider === undefined
      ? configured ? currentProviders[providerId] : backup[providerId]
      : {
          name: switchingProvider.name,
          base_url: switchingProvider.baseUrl,
          wire_api: "responses",
          supports_websockets: switchingProvider.supportsWebsockets,
          experimental_bearer_token: switchingProvider.apiKey,
        })
    : {};
  if (
    input.operation === "update"
    && (typeof existing.base_url !== "string" || existing.wire_api !== "responses")
  ) {
    throw invalid("provider-not-found", "providerId", `未找到可编辑的自定义主 Provider：${providerId}`);
  }
  const baseUrl = validCustomPrimaryProviderBaseUrl(input.baseUrl);
  const displayName = providerId === primaryProviderId
    ? primaryProviderId
    : requiredString(input.name, "name", "显示名称不能为空");
  const mode = input.mode;
  if (mode !== "switching" && mode !== "exclusive") {
    throw invalid("invalid-mode", "mode", "运行模式必须是 switching 或 exclusive");
  }
  if (typeof input.supportsWebsockets !== "boolean") {
    throw invalid("invalid-websocket-setting", "supportsWebsockets", "WebSocket 设置必须是布尔值");
  }
  const officialModelIds = new Set(
    officialModels.filter((candidate) => candidate.available !== false)
      .map((candidate) => candidate.model),
  );
  if (officialModelIds.size === 0) {
    throw invalid("official-models-unavailable", "model", "Codex App Server 没有返回可用的官方模型");
  }
  const model = requiredString(input.model, "model", "模型 ID 不能为空");
  if (!officialModelIds.has(model)) {
    throw invalid("unknown-model", "model", `模型 ID 不在 Codex 官方模型目录中：${model}`);
  }
  const activeProviderId = optionalString(config.model_provider);
  const effectiveActiveProviderId = activeProviderId
    ?? (configuredProviderIds.length === 1 ? configuredProviderIds[0] : undefined);
  const hasOfficialMainProvider = effectiveActiveProviderId === undefined
    || effectiveActiveProviderId === "openai";
  const hasCustomFixedMainProvider = effectiveActiveProviderId !== undefined
    && configuredProviderIds.includes(effectiveActiveProviderId);
  const fixedProviderFromConfig = input.operation === "update"
    && switchingProvider === undefined
    && configured;
  if (
    mode === "switching"
    && effectiveActiveProviderId !== undefined
    && effectiveActiveProviderId !== "openai"
  ) {
    throw invalid(
      "official-mode-required",
      "mode",
      `当前固定主 Provider ${effectiveActiveProviderId} 必须先切回官方 OpenAI，才能启用自定义切换模式`,
    );
  }
  if (mode === "switching" && fixedProviderFromConfig) {
    throw invalid(
      "fixed-candidate-must-be-backed-up",
      "mode",
      "自定义切换模式不修改主配置；请先运行 codexc primary-provider switch openai 将主配置候选移入私有备份，再重新编辑",
    );
  }
  if (mode === "exclusive") {
    if (hasCustomFixedMainProvider && effectiveActiveProviderId !== providerId) {
      assertProviderNotInUse(effectiveActiveProviderId, environment);
    }
    if (!hasOfficialMainProvider && !hasCustomFixedMainProvider) {
      throw invalid(
        "managed-fixed-provider-active",
        "mode",
        `当前受管固定 Provider ${effectiveActiveProviderId} 必须先恢复官方模式，才能配置自定义固定 Provider`,
      );
    }
    const otherSwitchingProviderIds = switchingProviders
      .map(({ id }) => id)
      .filter((id) => id !== providerId);
    if (otherSwitchingProviderIds.length > 0) {
      throw invalid(
        "other-switching-providers",
        "mode",
        `固定模式不能保留其他自定义切换 Provider；请先删除其他自定义切换 Provider：${otherSwitchingProviderIds.join("、")}`,
      );
    }
  }
  const hasTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  if (mode === "switching" && hasTopLevelBaseUrl) {
    throw invalid(
      "top-level-base-url-conflict",
      "mode",
      "自定义切换模式不会修改主配置；请先移除主配置中的 openai_base_url",
    );
  }
  const removesTopLevelBaseUrl = mode === "exclusive" && hasTopLevelBaseUrl;
  if (
    requireConfirmation
    && removesTopLevelBaseUrl
    && input.confirmRemoveTopLevelBaseUrl !== true
  ) {
    throw invalid(
      "confirmation-required",
      "confirmRemoveTopLevelBaseUrl",
      "固定模式写入前必须确认移除顶层 openai_base_url",
    );
  }
  const currentBaseUrl = optionalString(existing.base_url);
  const currentApiKey = optionalString(existing.experimental_bearer_token);
  const canPreserveApiKey = currentApiKey !== undefined
    && currentBaseUrl !== undefined
    && sameUrlOrigin(currentBaseUrl, baseUrl);
  const credential = record(input.credential);
  let apiKey;
  if (credential.action === "preserve") {
    if (!canPreserveApiKey) {
      throw invalid("api-key-replacement-required", "credential", "API Key 不能为空");
    }
    apiKey = currentApiKey;
  } else if (credential.action === "replace") {
    apiKey = requiredString(credential.apiKey, "credential.apiKey", "API Key 不能为空");
  } else {
    throw invalid("invalid-credential-action", "credential", "凭据操作必须是 preserve 或 replace");
  }
  const providerBlock = createCustomPrimaryProviderConfig({
    name: displayName,
    baseUrl,
    auth: "bearer_token",
    bearerToken: apiKey,
    supportsWebsockets: input.supportsWebsockets,
  });
  const provider = {
    id: providerId,
    displayName,
    baseUrl,
    mode,
    model,
    supportsWebsockets: input.supportsWebsockets,
    catalog: "official",
    hasApiKey: true,
  };
  return {
    provider,
    apiKey,
    expectedVersion: snapshot.version,
    switchingProvider,
    registeredProviderIds: switchingProviders.map(({ id }) => id),
    providerIdToDeactivate: hasCustomFixedMainProvider
      && effectiveActiveProviderId !== providerId
      ? effectiveActiveProviderId
      : undefined,
    backupCandidateToRemove: input.operation === "update" && backedUp
      ? providerId
      : undefined,
    effects: {
      removesTopLevelBaseUrl,
      convertsSwitchingProfile: switchingProvider !== undefined && mode === "exclusive",
      consumesBackupCandidate: input.operation === "update" && backedUp,
      preservesApiKey: credential.action === "preserve",
    },
    edits: mode === "exclusive" ? [
      ...(removesTopLevelBaseUrl ? [{ keyPath: "openai_base_url", value: null }] : []),
      { keyPath: "model_provider", value: providerId },
      { keyPath: "model", value: model },
      ...modelProviderBlockEdits(providerId, providerBlock),
    ] : [],
  };
}

async function loadSaveContext({
  environment = process.env,
  createClient = createCodexUserConfigClient,
  loadContext,
}) {
  if (loadContext !== undefined) return loadContext();
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [snapshot, officialModels] = await Promise.all([
      client.readUserConfigSnapshot(),
      client.listModels(),
    ]);
    return { snapshot, officialModels };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function normalizeProviderId(value, environment) {
  const normalized = typeof value === "string" ? value.trim() : "";
  const validationError = validateCustomPrimaryModelProviderId(normalized, environment);
  if (validationError !== null) {
    throw invalid("invalid-provider-id", "providerId", validationError);
  }
  return normalized;
}

function readBackup(environment) {
  try {
    return readPrimaryProviderBackup(environment);
  } catch (error) {
    throw invalid(
      "provider-state-unavailable",
      "providerId",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function sameUrlOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function assertProviderNotInUse(providerId, environment) {
  try {
    assertThirdPartyRoleDoesNotUseProvider(providerId, environment);
  } catch (error) {
    throw invalid(
      "provider-in-use",
      "providerId",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function requiredString(value, field, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") throw invalid("required", field, message);
  return normalized;
}

function invalid(code, field, message, cause) {
  return new PrimaryProviderManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
