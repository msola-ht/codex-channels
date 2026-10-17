import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { readOfficialModelCatalog } from "../runtime/model-provider-official-catalog.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { createProviderFileReader } from "../runtime/provider-file-access.mjs";
import { assertProviderModelRequestPolicy } from "../runtime/model-request-policy.mjs";
import { withCustomBaseTemplate } from "../runtime/model-template-catalog.mjs";
import { createResponsesModelCatalog, compileResponsesModelCatalog, isCustomCatalogProvider, responsesProviderCatalogPath, responsesProviderBackupPath, readResponsesModelCatalog, validateResponsesModels, writeResponsesModelCatalog, withResponsesModelCatalogWrite, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import { customProviderUpstreamMetadataPath, customProviderUpstreamWireApis, readCustomProviderUpstreamWireApi, removeCustomProviderUpstreamMetadata, writeCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { createHmac, randomBytes } from "node:crypto";

import {
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomPrimaryCredential,
  loadCustomSwitchingProviderIds,
  assertCustomPrimaryProviderAuthentication,
  loadConfiguredCustomSwitchingModelProviders,
  readPrimaryProviderBackup,
  removePrimaryProviderBackupCandidate,
  validProviderBaseUrl,
  validateCustomPrimaryModelProviderId,
  writeCustomPrimaryProviderSwitchingProfile,
  customPrimaryProviderProfilePath,
  customSwitchingProviderRegistryPath,
  restoreCustomPrimaryProviderSwitchingProfile,
  customPrimaryProviderCredentialEnvironmentKey,
  readCustomPrimaryProviderApiKey,
} from "../runtime/model-provider-runtime.mjs";
import {
  createCustomPrimaryProviderConfig,
  modelProviderBlockEdits,
} from "../runtime/model-provider-profile.mjs";
import { areCodexUserConfigEditsApplied, createCodexUserConfigClient } from "./codex-user-config.mjs";
import {
  writePrimaryProviderConfigEditsWithProfileRemoval,
} from "./primary-provider-config-transaction.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { PrimaryProviderManagementError } from "./primary-provider-management.mjs";

export const primaryProviderId = "OpenAI";

// Process-local authentication prevents exposing a reusable hash of a stored key.
// Restarting invalidates outstanding probe drafts; no persistent format is added.
const probeConnectionSecret = randomBytes(32);
export function customModelProbeConnection({ baseUrl, upstreamWireApi, apiKey, model, reasoningEffort, capability }) {
  return createHmac("sha256", probeConnectionSecret)
    .update(JSON.stringify([validCustomPrimaryProviderBaseUrl(baseUrl), upstreamWireApi, apiKey, model, reasoningEffort, capability]))
    .digest("hex");
}

export function customPrimaryProviderIdFromBaseUrl(baseUrl, catalogKind, environment = process.env) {
  if (catalogKind !== "official" && catalogKind !== "custom") {
    throw invalid("invalid-catalog", "catalog", "模型目录来源不受支持");
  }
  const hostname = new URL(validCustomPrimaryProviderBaseUrl(baseUrl)).hostname.toLowerCase();
  const stem = hostname
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, catalogKind === "custom" ? 61 : 64);
  const id = catalogKind === "custom" ? `cp-${stem}` : stem;
  const validationError = validateCustomPrimaryModelProviderId(id, environment)
    ?? (catalogKind === "official" && isCustomCatalogProvider(id)
      ? "Codex 兼容 Provider 不使用 cp- 前缀" : null);
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
  return normalized;
}

export function customPrimaryProviderUrlsShareOrigin(left, right) {
  return sameUrlOrigin(left, right);
}

export async function previewCustomPrimaryProviderSave(input, options = {}) {
  const plan = await buildSavePlan(input, options, { requireConfirmation: false });
  return publicSavePreview(input, plan);
}

/** Model-only edits resolve connection settings again, never accept them from a stale form. */
export async function previewCustomProviderModelsSave(input, options = {}) {
  const { saveInput, plan } = await buildModelOnlySavePlan(input, options);
  return modelOnlyPreview(saveInput, plan);
}

export async function applyCustomProviderModelsSave(input, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const { saveInput, plan } = await buildModelOnlySavePlan(input, options);
    const preview = modelOnlyPreview(saveInput, plan);
    if (typeof options.preview?.revision !== "string" || options.preview.revision !== preview.revision) {
      throw invalid("stale-preview", "catalog", "模型或连接配置已变化，请重新预览");
    }
    return { ...await applySavePlan(saveInput, plan, options), operation: "model.custom.save" };
  });
}

function modelOnlyPreview(input, plan) {
  return {
    ...publicSavePreview(input, plan), operation: "model.custom.save",
    // Includes credentials without disclosing a reusable digest of a stored secret.
    revision: createHmac("sha256", probeConnectionSecret).update(JSON.stringify(plan)).digest("hex"),
  };
}

async function buildModelOnlySavePlan(input, options) {
  const environment = options.environment ?? process.env;
  if (!input || typeof input.provider !== "string" || !isCustomCatalogProvider(input.provider)) {
    throw invalid("invalid-provider-id", "provider", "请选择已配置的自定义模型提供商");
  }
  const context = await loadSaveContext(options, false);
  const config = record(context.snapshot.config);
  const switching = loadConfiguredCustomSwitchingModelProviders(environment).find(entry => entry.id === input.provider);
  const fixed = record(record(config.model_providers)[input.provider]);
  if (!switching && config.model_provider !== input.provider) {
    throw invalid("provider-not-found", "provider", "仅能编辑已启用的自定义模型提供商");
  }
  if (!switching) {
    try {
      if (loadConfiguredCustomPrimaryModelProvider(environment)?.id !== input.provider) throw new Error("Provider 不匹配");
    } catch (error) {
      throw invalid("invalid-catalog", "provider", "当前固定提供商配置不受支持，请先修复连接配置", error);
    }
  }
  const previous = readResponsesModelCatalog(environment, input.provider);
  if (options.expectedCatalogContent !== undefined && previous.content !== options.expectedCatalogContent) {
    throw invalid("stale-preview", "catalog", "模型目录已变化，请重新打开模型管理");
  }
  if (!Array.isArray(input.models) || previous.definitions.some(entry => !input.models.some(next => next?.id === entry.id))) {
    throw invalid("invalid-catalog", "models", "移除已有模型请使用独立移除入口；重命名请先添加新模型");
  }
  const saveInput = {
    operation: "update", providerId: input.provider,
    name: switching?.name ?? fixed.name,
    baseUrl: switching?.baseUrl ?? fixed.base_url,
    mode: switching ? "switching" : "exclusive",
    model: input.model, catalog: { kind: "custom", models: input.models },
    supportsWebsockets: switching?.supportsWebsockets ?? fixed.supports_websockets === true,
    upstreamWireApi: readCustomProviderUpstreamWireApi(environment, input.provider),
    credential: { action: "preserve" },
    ...(input.probeConnections === undefined ? {} : { probeConnections: input.probeConnections }),
  };
  const plan = await buildSavePlan(saveInput, { ...options, loadContext: async () => context }, { requireConfirmation: true });
  plan.modelOnly = true;
  plan.modelOnlyFixedProvider = switching ? undefined : fixed;
  plan.credential = undefined;
  plan.edits = switching ? [] : [
    { keyPath: "model", value: plan.provider.model },
    { keyPath: "model_reasoning_effort", value: plan.reasoningEffort },
  ];
  return { saveInput, plan };
}

export async function prepareCustomPrimaryProviderSave(input, options = {}) {
  const plan = await buildSavePlan(input, options, { requireConfirmation: true });
  const preview = publicSavePreview(input, plan);
  return {
    preview,
    // A CLI draft may have supplied its opening snapshot. Execution must read again.
    apply: () => applyCustomPrimaryProviderSave(input, { ...options, loadContext: undefined, preview }),
  };
}

function publicSavePreview(input, plan) {
  const cleartext = new URL(plan.provider.baseUrl).protocol === "http:";
  return {
    operation: input.operation,
    revision: savePlanRevision(plan),
    provider: plan.provider,
    transport: { scheme: cleartext ? "http" : "https", cleartext },
    activation: "restart-all",
    effects: plan.effects,
    credential: {
      action: input.credential.action,
      storedAsPlaintext: true,
      destination: plan.provider.mode === "switching" ? "private-profile" : "private-credential",
    },
  };
}

export async function applyCustomPrimaryProviderSave(input, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await buildSavePlan(input, options, { requireConfirmation: true });
    if (typeof options.preview?.revision !== "string" || options.preview.revision !== savePlanRevision(plan)) {
      throw invalid("stale-preview", "operation", "提供商或模型配置已变化，请重新预览后再保存");
    }
    return applySavePlan(input, plan, options);
  });
}

function savePlanRevision(plan) {
  // Credential version IDs are freshly allocated per plan, not source revisions.
  // Bind the effective secret with a process-local HMAC, never a reusable key hash.
  return createHmac("sha256", probeConnectionSecret).update(JSON.stringify({
    provider: plan.provider, apiKey: plan.apiKey, expectedVersion: plan.expectedVersion,
    catalogRevision: plan.catalogRevision, switchingProvider: plan.switchingProvider,
    registeredProviderIds: plan.registeredProviderIds, effects: plan.effects,
    sourceState: plan.sourceState,
  })).digest("hex");
}

async function applySavePlan(input, plan, options) {
  if (plan.models === undefined) {
    const result = await applyConnectionSavePlan(input, plan, options);
    await confirmProviderSave(plan, options);
    return result;
  }
  const environment = options.environment ?? process.env;
  if (JSON.stringify(compileResponsesModelCatalog(plan.models, plan.provider.model)) !== plan.validatedCatalog) throw invalid("stale-preview", "catalog", "模型目录已变化，请重新预览并校验");
  const configPath = join(codexHomePath(environment), "config.toml");
  const read = createProviderFileReader(environment);
  const beforeConfig = existsSync(configPath) ? read(configPath) : undefined;
  const profilePath = customPrimaryProviderProfilePath(environment, plan.provider.id);
  const beforeProfile = existsSync(profilePath) ? read(profilePath) : undefined;
  const backupPaths = [configPath, customPrimaryProviderProfilePath(environment, plan.provider.id), customSwitchingProviderRegistryPath(environment),
    ...(isCustomCatalogProvider(plan.provider.id) ? [customProviderUpstreamMetadataPath(environment, plan.provider.id)] : [])];
  const transaction = writeResponsesModelCatalog(environment, plan.provider.id, plan.models, plan.provider.model, plan.catalogRevision);
  try {
    writePrivateFileAtomicSync(responsesProviderBackupPath(environment, plan.provider.id), `${JSON.stringify({
      schemaVersion: 1,
      files: backupPaths.map(path => ({ path, content: existsSync(path) ? read(path) : null })),
    }, null, 2)}\n`);
    const result = await withResponsesModelCatalogWrite(transaction, async () => {
      const result = await applyConnectionSavePlan(input, plan, options);
      await confirmProviderSave(plan, options, transaction);
      return result;
    });
    finishResponsesModelCatalogWrite(transaction);
    return result;
  } catch (error) {
    if (error?.code === "save-unconfirmed") throw error;
    const afterConfig = existsSync(configPath) ? read(configPath) : undefined;
    const afterProfile = existsSync(profilePath) ? read(profilePath) : undefined;
    if (beforeConfig === afterConfig && (afterProfile === beforeProfile || (plan.switchingProvider && afterProfile === undefined))) {
      finishResponsesModelCatalogWrite(transaction, true);
      if (plan.switchingProvider && !existsSync(customPrimaryProviderProfilePath(environment, plan.provider.id))) {
        restoreCustomPrimaryProviderSwitchingProfile(environment, plan.provider.id, plan.switchingProvider.profileContent);
      }
    } else {
      // Preserve both revisions when the remote write outcome cannot be established.
      throw new AggregateError([error], "自定义提供商保存结果无法确认；已保留模型目录及 .backup，请检查配置后恢复，勿自动重试", { cause: error });
    }
    throw error;
  }
}

async function confirmProviderSave(plan, options, transaction) {
  const environment = options.environment ?? process.env;
  try {
    const { snapshot } = await loadSaveContext({ ...options, loadContext: undefined }, false);
    const config = record(snapshot.config);
    const read = createProviderFileReader(environment);
    if (transaction) {
      const catalog = readResponsesModelCatalog(environment, plan.provider.id);
      if (catalog.content !== transaction.content
        || transaction.previous && read(`${transaction.path}.backup`, 2_097_152) !== transaction.previous.content
        || read(`${transaction.path}.pending`, 1024) !== transaction.pendingContent
        || readCustomProviderUpstreamWireApi(environment, plan.provider.id) !== plan.upstreamWireApi) throw new Error("模型目录或恢复材料已变化");
    }
    if (plan.provider.mode === "switching") {
      const profiles = loadConfiguredCustomSwitchingModelProviders(environment);
      const actual = profiles.find(entry => entry.id === plan.provider.id);
      if (!isDeepStrictEqual(config.model_provider, "openai") && config.model_provider !== undefined) throw new Error("主提供商已变化");
      const expectedIds = [...new Set([...plan.registeredProviderIds, plan.provider.id])].sort();
      if (!actual || actual.name !== plan.provider.displayName || actual.baseUrl !== plan.provider.baseUrl
        || actual.apiKey !== plan.apiKey || actual.model !== plan.provider.model
        || actual.supportsWebsockets !== plan.provider.supportsWebsockets || actual.upstreamWireApi !== plan.upstreamWireApi
        || plan.models && actual.reasoningEffort !== plan.reasoningEffort
        || !isDeepStrictEqual(profiles.map(entry => entry.id).sort(), expectedIds)) throw new Error("模型默认值或连接配置回读不一致");
      if (plan.modelOnly) {
        const expected = parse(plan.switchingProvider.profileContent);
        expected.model = plan.provider.model;
        expected.model_reasoning_effort = plan.reasoningEffort;
        if (!isDeepStrictEqual(parse(actual.profileContent), expected)) throw new Error("模型专用保存改变了连接配置");
      }
    } else {
      const provider = record(record(config.model_providers)[plan.provider.id]);
      const primary = loadConfiguredCustomPrimaryModelProvider(environment);
      if (!areCodexUserConfigEditsApplied(config, plan.edits)
        || primary?.id !== plan.provider.id || primary.baseUrl !== plan.provider.baseUrl
        || primary.upstreamWireApi !== plan.upstreamWireApi
        || loadConfiguredCustomPrimaryCredential(environment, primary)?.apiKey !== plan.apiKey
        || loadCustomSwitchingProviderIds(environment).length !== 0
        || plan.modelOnly && !isDeepStrictEqual(provider, plan.modelOnlyFixedProvider)) throw new Error("模型默认值或连接配置回读不一致");
    }
  } catch (error) {
    throw invalid("save-unconfirmed", "catalog", transaction
      ? "提供商保存结果无法确认；已保留 pending 和备份，请核对后恢复，勿自动重试"
      : "提供商保存结果无法确认；请核对配置与凭据，勿自动重试", error);
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
        ...(plan.modelOnly ? { modelOnly: true } : {}),
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
      credential: plan.credential,
    });
  }
  // 元数据只属于自定义提供商（cp-*）；Codex 兼容 Provider 不写该文件。
  if (!plan.modelOnly && isCustomCatalogProvider(plan.provider.id)) {
    if (plan.upstreamWireApi === "chat_completions") {
      writeCustomProviderUpstreamWireApi(environment, plan.provider.id, plan.upstreamWireApi);
    } else {
      removeCustomProviderUpstreamMetadata(environment, plan.provider.id);
    }
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
  const metadataPath = isCustomCatalogProvider(providerId) ? customProviderUpstreamMetadataPath(environment, providerId) : undefined;
  const sourceState = { existing, backup, upstreamMetadataContent: metadataPath && existsSync(metadataPath)
    ? createProviderFileReader(environment)(metadataPath) : null };
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
  if (mode === "switching") {
    try { createProviderFileReader(environment)(join(codexHomePath(environment), "config.toml")); }
    catch (error) {
      throw invalid("primary-config-unavailable", "mode", "切换模式需要可读取的 Codex 主配置；请先通过 codexc config 保存配置后重试", error);
    }
  }
  if (typeof input.supportsWebsockets !== "boolean") {
    throw invalid("invalid-websocket-setting", "supportsWebsockets", "WebSocket 设置必须是布尔值");
  }
  const custom = input.catalog?.kind === "custom";
  // 未显式选择时沿用已保存的上游接口（新建与非 cp- Provider 使用 responses）；读取失败时失败关闭。
  const upstreamWireApi = input.upstreamWireApi
    ?? (isCustomCatalogProvider(providerId) ? readCustomProviderUpstreamWireApi(environment, providerId) : "responses");
  if (!customProviderUpstreamWireApis.includes(upstreamWireApi)) {
    throw invalid("invalid-upstream-wire-api", "upstreamWireApi", "上游接口必须是 responses 或 chat_completions");
  }
  if (upstreamWireApi === "chat_completions" && input.supportsWebsockets) {
    throw invalid("invalid-upstream-websocket", "supportsWebsockets", "Chat Completions 上游不支持 WebSocket");
  }
  if (upstreamWireApi === "chat_completions" && !custom) {
    throw invalid("invalid-upstream-wire-api", "upstreamWireApi", "Chat Completions 上游只支持自定义提供商");
  }
  if (input.catalog !== undefined && (input.catalog?.kind !== "custom" || Object.keys(input.catalog).some(key => !["kind", "models"].includes(key)))) throw invalid("invalid-catalog", "catalog", "模型目录来源不受支持");
  if (custom !== isCustomCatalogProvider(providerId)) throw invalid("invalid-provider-id", "providerId", "自定义提供商必须使用 cp- 前缀；Codex 兼容 Provider 不使用该前缀");
  if (custom && displayName === "OpenAI") throw invalid("reserved-provider-name", "name", "自定义提供商不能使用 OpenAI 显示名称，以免启用官方专用协议能力");
  const previousCatalog = custom && input.operation === "update" ? readResponsesModelCatalog(environment, providerId) : undefined;
  if (options.expectedCatalogContent !== undefined && previousCatalog?.content !== options.expectedCatalogContent) {
    throw invalid("stale-preview", "catalog", "模型目录已变化，请重新打开模型管理");
  }
  if (previousCatalog && (!Array.isArray(input.catalog.models) || previousCatalog.definitions.some(entry => !input.catalog.models.some(next => next?.id === entry.id)))) {
    throw invalid("invalid-catalog", "catalog", "移除已有模型请使用模型管理的本地移除入口");
  }
  if (custom && input.operation === "create" && existsSync(responsesProviderCatalogPath(environment, providerId))) throw invalid("provider-exists", "providerId", "该 Provider 已有模型目录，请先恢复或删除已有配置");
  const model = requiredString(input.model, "model", "模型 ID 不能为空");
  const existingIds = new Set(previousCatalog?.definitions.map(entry => entry.id));
  // Saved models are snapshots. Only new models receive missing base prompts.
  const models = custom ? validateResponsesModels(input.catalog.models, model).map(entry => existingIds.has(entry.id)
    ? entry : createResponsesModelCatalog([withCustomBaseTemplate(entry)], entry.id).definitions[0]) : undefined;
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
  const effectiveActiveProviderId = optionalString(config.model_provider);
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
      "自定义切换模式不修改主配置；请先运行 codexc provider switch openai 将主配置候选移入私有备份，再重新编辑",
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
  const credential = record(input.credential);
  const sameOrigin = currentBaseUrl !== undefined && sameUrlOrigin(currentBaseUrl, baseUrl);
  const currentApiKey = credential.action === "preserve" && sameOrigin
    ? readCustomPrimaryProviderApiKey(providerId, existing, environment) : undefined;
  const canPreserveApiKey = currentApiKey !== undefined
    && currentBaseUrl !== undefined
    && sameUrlOrigin(currentBaseUrl, baseUrl);
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
  if (apiKey.length > 4096 || /\p{Cc}/u.test(apiKey)) throw invalid("invalid-api-key", "credential.apiKey", "API Key 不能超过 4096 字符或包含控制字符");
  if (input.probeConnections !== undefined) {
    if (!Array.isArray(input.probeConnections) || input.probeConnections.length > 128
      || input.probeConnections.some(entry => !entry || typeof entry !== "object"
        || Array.isArray(entry) || Object.keys(entry).some(key => !["model", "token", "capability"].includes(key))
        || !["applyPatch", "toolSearch"].includes(entry.capability)
        || typeof entry.model !== "string" || typeof entry.token !== "string"
        || !/^[a-f0-9]{64}$/.test(entry.token)
        || !models?.some(model => model.id === entry.model)
        || entry.token !== customModelProbeConnection({ baseUrl, upstreamWireApi, apiKey, model: entry.model,
          reasoningEffort: models.find(model => model.id === entry.model).defaultReasoningEffort ?? "none", capability: entry.capability }))) {
      throw invalid("stale-model-probe", "catalog", "模型探测使用的连接或凭据已变化，请重新探测后保存");
    }
  }
  const providerBlock = createCustomPrimaryProviderConfig({
    name: displayName,
    baseUrl,
    auth: "env_key",
    envKey: customPrimaryProviderCredentialEnvironmentKey(providerId),
    supportsWebsockets: input.supportsWebsockets,
  });
  if (mode === "exclusive") {
    const effectiveProvider = { ...record(currentProviders[providerId]), ...providerBlock };
    delete effectiveProvider.experimental_bearer_token;
    try {
      assertCustomPrimaryProviderAuthentication(effectiveProvider);
      assertProviderModelRequestPolicy(effectiveProvider);
    } catch (error) {
      throw invalid("unsupported-provider-config", "providerId", "固定提供商包含不受支持的认证或请求策略配置；请先修正已有配置，未执行保存", error);
    }
  }
  const catalog = models ? compileResponsesModelCatalog(models, model) : undefined;
  if (catalog) await validateModelCatalogWithCodex(catalog, environment);
  const provider = {
    id: providerId,
    displayName,
    baseUrl,
    mode,
    model,
    supportsWebsockets: input.supportsWebsockets,
    upstreamWireApi,
    catalog: custom ? "custom" : "official",
    ...(models ? { models } : {}),
    hasApiKey: true,
  };
  return {
    sourceState,
    provider,
    upstreamWireApi,
    models,
    validatedCatalog: catalog ? JSON.stringify(catalog) : undefined,
    reasoningEffort,
    catalogRevision: previousCatalog?.revision,
    apiKey,
    credential: mode === "exclusive" ? { providerId, baseUrl, apiKey, environmentKey: providerBlock.env_key } : undefined,
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
      ] : isCustomCatalogProvider(effectiveActiveProviderId) ? [
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
    return { snapshot, officialModels: includeOfficialModels && isCustomCatalogProvider(record(snapshot.config).model_provider)
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
