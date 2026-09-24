import { readOfficialModelCatalog } from "../runtime/model-provider-official-catalog.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { isResponsesProvider, responsesProviderCatalogPath, responsesProviderBackupPath, readResponsesModelCatalog, validateResponsesModels, writeResponsesModelCatalog, withResponsesModelCatalogWrite, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
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
  customPrimaryProviderProfilePath,
  customSwitchingProviderRegistryPath,
  restoreCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import {
  createCustomPrimaryProviderConfig,
  modelProviderBlockEdits,
} from "../runtime/model-provider-profile.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import {
  writePrimaryProviderConfigEditsWithProfileRemoval,
} from "./primary-provider-config-transaction.mjs";
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
  if (plan.models === undefined) return applyConnectionSavePlan(input, plan, options);
  const environment = options.environment ?? process.env;
  const configPath = join(codexHomePath(environment), "config.toml");
  const beforeConfig = existsSync(configPath) ? readPrivateFileSync(configPath) : undefined;
  const profilePath = customPrimaryProviderProfilePath(environment, plan.provider.id);
  const beforeProfile = existsSync(profilePath) ? readPrivateFileSync(profilePath) : undefined;
  const backupPaths = [configPath, customPrimaryProviderProfilePath(environment, plan.provider.id), customSwitchingProviderRegistryPath(environment)];
  const transaction = writeResponsesModelCatalog(environment, plan.provider.id, plan.models, plan.provider.model, plan.catalogRevision);
  try {
    writePrivateFileAtomicSync(responsesProviderBackupPath(environment, plan.provider.id), JSON.stringify({
      schemaVersion: 1,
      files: backupPaths.map(path => ({ path, content: existsSync(path) ? readPrivateFileSync(path) : null })),
    }));
    const result = await withResponsesModelCatalogWrite(transaction, () => applyConnectionSavePlan(input, plan, options));
    finishResponsesModelCatalogWrite(transaction);
    return result;
  } catch (error) {
    const afterConfig = existsSync(configPath) ? readPrivateFileSync(configPath) : undefined;
    const afterProfile = existsSync(profilePath) ? readPrivateFileSync(profilePath) : undefined;
    if (beforeConfig === afterConfig && (afterProfile === beforeProfile || (plan.switchingProvider && afterProfile === undefined))) {
      finishResponsesModelCatalogWrite(transaction, true);
      if (plan.switchingProvider && !existsSync(customPrimaryProviderProfilePath(environment, plan.provider.id))) {
        restoreCustomPrimaryProviderSwitchingProfile(environment, plan.provider.id, plan.switchingProvider.profileContent);
      }
    } else {
      // Preserve both revisions when the remote write outcome cannot be established.
      throw new AggregateError([error], "Responses Provider 保存结果无法确认；已保留模型目录及 .backup，请检查配置后恢复，勿自动重试", { cause: error });
    }
    throw error;
  }
}

async function applyConnectionSavePlan(input, plan, options) {
  const { environment = process.env, createClient = createCodexUserConfigClient } = options;
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
        catalogSource: plan.models === undefined ? { kind: "official" } : { kind: "custom", reasoningEffort: plan.reasoningEffort },
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
  const { snapshot, officialModels } = await loadSaveContext(options, input.catalog?.kind !== "custom");
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
  const custom = input.catalog?.kind === "custom";
  if (input.catalog !== undefined && (input.catalog?.kind !== "custom" || Object.keys(input.catalog).some(key => !["kind", "models"].includes(key)))) throw invalid("invalid-catalog", "catalog", "模型目录来源不受支持");
  if (custom !== isResponsesProvider(providerId)) throw invalid("invalid-provider-id", "providerId", "自定义 Responses Provider 必须使用 responses- 前缀；Codex 兼容 Provider 不使用该前缀");
  if (custom && displayName === "OpenAI") throw invalid("reserved-provider-name", "name", "自定义 Responses Provider 不能使用 OpenAI 显示名称，以免启用官方专用协议能力");
  const previousCatalog = custom && input.operation === "update" ? readResponsesModelCatalog(environment, providerId) : undefined;
  if (custom && input.operation === "create" && existsSync(responsesProviderCatalogPath(environment, providerId))) throw invalid("provider-exists", "providerId", "该 Provider 已有模型目录，请先恢复或删除已有配置");
  const model = requiredString(input.model, "model", "模型 ID 不能为空");
  const models = custom ? validateResponsesModels(input.catalog.models, model) : undefined;
  const reasoningEffort = models?.find((entry) => entry.id === model)?.defaultReasoningEffort ?? "none";
  const officialModelIds = new Set(
    officialModels.filter((candidate) => candidate.available !== false)
      .map((candidate) => candidate.model),
  );
  if (!custom && officialModelIds.size === 0) {
    throw invalid("official-models-unavailable", "model", "Codex App Server 没有返回可用的官方模型");
  }
  if (!custom && !officialModelIds.has(model)) {
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
    catalog: custom ? "custom" : "official",
    ...(models ? { models } : {}),
    hasApiKey: true,
  };
  return {
    provider,
    models,
    reasoningEffort,
    catalogRevision: previousCatalog?.revision,
    apiKey,
    expectedVersion: snapshot.version,
    switchingProvider,
    registeredProviderIds: switchingProviders.map(({ id }) => id),
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
      ...(custom ? [
        { keyPath: "model_catalog_json", value: responsesProviderCatalogPath(environment, providerId) },
        { keyPath: "model_reasoning_effort", value: reasoningEffort },
      ] : isResponsesProvider(effectiveActiveProviderId) ? [
        { keyPath: "model_catalog_json", value: null },
        { keyPath: "model_reasoning_effort", value: null },
      ] : []),
      ...modelProviderBlockEdits(providerId, providerBlock),
    ] : [],
  };
}

async function loadSaveContext({
  environment = process.env,
  createClient = createCodexUserConfigClient,
  loadContext,
}, includeOfficialModels = true) {
  if (loadContext !== undefined) return loadContext();
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [snapshot, officialModels] = await Promise.all([
      client.readUserConfigSnapshot(),
      includeOfficialModels ? client.listModels() : [],
    ]);
    return { snapshot, officialModels: includeOfficialModels && isResponsesProvider(record(snapshot.config).model_provider)
      ? bundledOfficialModelOptions(environment) : officialModels };
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

export function bundledOfficialModelOptions(environment = process.env) {
  return readOfficialModelCatalog(environment).models
    .filter(model => model.supported_in_api && model.visibility === "list")
    .map(model => ({model: model.slug, available: true}));
}
