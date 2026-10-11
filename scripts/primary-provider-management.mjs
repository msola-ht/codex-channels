import { readOfficialModelCatalog } from "../runtime/model-provider-official-catalog.mjs";
import { isResponsesProvider, responsesModelSettings, responsesProviderCatalogPath, responsesProviderBackupPath, removeResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { removeCustomProviderUpstreamMetadata } from "../runtime/model-provider-upstream-metadata.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";

import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  loadCustomSwitchingProviderIds,
  readPrimaryProviderBackup,
  removeCustomPrimaryProviderSwitchingProfile,
  removePrimaryProviderBackupCandidate,
  validateCustomPrimaryModelProviderId,
  customPrimaryProviderCredentialEnvironmentKey,
  readCustomPrimaryProviderApiKey,
  removeCustomPrimaryProviderCredentials,
  assertCustomPrimaryProviderAuthentication,
} from "../runtime/model-provider-runtime.mjs";
import { thirdPartyProviderRequestMaxRetries, thirdPartyProviderStreamMaxRetries } from "../runtime/model-provider-profile.mjs";
import {
  createCodexUserConfigClient,
  readCodexUserConfigSnapshot,
} from "./codex-user-config.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import {
  writePrimaryProviderConfigEditsWithProfileRemoval,
} from "./primary-provider-config-transaction.mjs";

export class PrimaryProviderManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "PrimaryProviderManagementError";
    this.code = code;
    this.field = field;
  }
}

export async function previewPrimaryProviderSwitch(
  input,
  options = {},
) {
  return publicSwitchPreview(await buildSwitchPlan(input, options));
}

export async function applyPrimaryProviderSwitch(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await buildSwitchPlan(input, options);
    return applyPrimaryProviderSwitchPlan(plan, options);
  });
}

async function applyPrimaryProviderSwitchPlan(plan, options) {
  const {
    environment = process.env,
    createClient = createCodexUserConfigClient,
  } = options;
  let backedUpProviderIds = [];
  if (plan.target.source === "official") {
    backedUpProviderIds = backupPrimaryProviderCandidates(plan.providers, environment);
  }
  await writePrimaryProviderConfigEditsWithProfileRemoval({
    environment,
    providerId: plan.profileToRemove,
    edits: plan.edits,
    expectedVersion: plan.expectedVersion,
    createClient,
    credential: plan.credential,
  });
  let backupCleaned = true;
  if (plan.backupCandidateToRemove !== undefined) {
    try {
      removePrimaryProviderBackupCandidate(plan.backupCandidateToRemove, environment);
    } catch {
      backupCleaned = false;
    }
  }
  return {
    action: "switched",
    target: plan.target,
    activation: "restart-all",
    effects: {
      ...plan.effects,
      backedUpProviderIds,
    },
    warnings: backupCleaned
      ? []
      : [{ code: "backup-cleanup-failed", providerId: plan.target.id }],
  };
}

export async function previewPrimaryProviderRemoval(
  input,
  options = {},
) {
  return publicRemovalPreview(await buildRemovalPlan(input, options));
}

export async function applyPrimaryProviderRemoval(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await removalPlanForExecution(input, options.preview, options);
    return applyPrimaryProviderRemovalPlan(plan, options);
  });
}

async function applyPrimaryProviderRemovalPlan(plan, options) {
  const {
    environment = process.env,
    createClient = createCodexUserConfigClient,
  } = options;
  let backupCleaned = true;
  if (plan.target.state === "orphan-catalog") {
    removeCustomPrimaryProviderSwitchingProfile(environment, plan.target.id);
  } else if (plan.target.state === "stale-switching") {
    removeCustomPrimaryProviderSwitchingProfile(environment, plan.target.id);
    backupCleaned = removeBackupCandidateSafely(plan.target.id, environment);
  } else if (plan.target.state === "switching") {
    try {
      removeCustomPrimaryProviderSwitchingProfile(
        environment,
        plan.target.id,
        plan.expectedProfileContent,
      );
    } catch (error) {
      if (error?.code === "CUSTOM_SWITCHING_PROFILE_CHANGED") {
        throw invalid(
          "stale-preview",
          "preview",
          "Provider 状态已变化，请重新生成删除预览",
          error,
        );
      }
      throw error;
    }
    backupCleaned = removeBackupCandidateSafely(plan.target.id, environment);
  } else if (plan.target.state === "backup") {
    removePrimaryProviderBackupCandidate(plan.target.id, environment);
  } else {
    await writePrimaryProviderConfigEditsWithProfileRemoval({
      environment,
      providerId: plan.target.id,
      edits: plan.edits,
      expectedVersion: plan.expectedVersion,
      createClient,
    });
    backupCleaned = removeBackupCandidateSafely(plan.target.id, environment);
  }
  let credentialsCleaned = true;
  if (backupCleaned) {
    try { removeCustomPrimaryProviderCredentials(environment, plan.target.id); }
    catch { credentialsCleaned = false; }
  }
  if (backupCleaned && isResponsesProvider(plan.target.id)) {
    removeResponsesModelCatalog(environment, plan.target.id);
    removeCustomProviderUpstreamMetadata(environment, plan.target.id);
  }
  return {
    action: "removed",
    target: plan.target,
    activation: plan.activation,
    effects: plan.effects,
    warnings: [
      ...(!backupCleaned ? [{ code: "backup-cleanup-failed", providerId: plan.target.id }] : []),
      ...(!credentialsCleaned ? [{ code: "credential-cleanup-failed", providerId: plan.target.id }] : []),
    ],
  };
}

async function removalPlanForExecution(input, preview, options) {
  if (preview === undefined) return buildRemovalPlan(input, options);
  const { environment = process.env } = options;
  const normalizedId = normalizeProviderId(input.providerId);
  if (
    preview?.operation !== "remove"
    || preview.target?.id !== normalizedId
  ) {
    throw invalid(
      "invalid-preview",
      "preview",
      "删除预览与当前 Provider 不匹配，请重新生成预览",
    );
  }
  if (preview.target.state === "stale-switching") {
    const registered = loadCustomSwitchingProviderIds(environment).includes(normalizedId);
    const profileExists = existsSync(customPrimaryProviderProfilePath(environment, normalizedId));
    if (!registered || profileExists) {
      throw invalid("stale-preview", "preview", "Provider 状态已变化，请重新生成删除预览");
    }
    return currentRemovalPlan(preview, {
      target: preview.target,
      activation: "restart-all",
      effects: { restoresOfficial: false },
    });
  }
  if (preview.target.state === "switching") {
    const switching = registeredSwitchingProviderForRemoval(environment, normalizedId);
    if (switching === undefined) {
      throw invalid("stale-preview", "preview", "Provider 状态已变化，请重新生成删除预览");
    }
    return currentRemovalPlan(preview, {
      target: {
        id: switching.id,
        displayName: switching.name,
        baseUrl: switching.baseUrl,
        state: "switching",
        active: false,
      },
      activation: "restart-all",
      effects: { restoresOfficial: false },
      expectedProfileContent: switching.profileContent,
    });
  }
  if (preview.target.state === "configured") {
    const {
      createClient = createCodexUserConfigClient,
    } = options;
    const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
    const config = record(snapshot.config);
    const providers = record(config.model_providers);
    if (!listCustomPrimaryProviderCandidates(providers).includes(normalizedId)) {
      throw invalid("stale-preview", "preview", "Provider 状态已变化，请重新生成删除预览");
    }
    if (loadCustomSwitchingProviderIds(environment).includes(normalizedId)) {
      throw invalid("stale-preview", "preview", "Provider 状态已变化，请重新生成删除预览");
    }
    const provider = record(providers[normalizedId]);
    const activeProviderId = optionalString(config.model_provider) ?? "openai";
    const restoresOfficial = activeProviderId === normalizedId;
    return currentRemovalPlan(preview, {
      target: {
        id: normalizedId,
        displayName: optionalString(provider.name) ?? normalizedId,
        baseUrl: optionalString(provider.base_url) ?? "",
        state: "configured",
        active: restoresOfficial,
      },
      expectedVersion: snapshot.version,
      activation: "restart-all",
      effects: { restoresOfficial },
      edits: [
        { keyPath: `model_providers.${normalizedId}`, value: null },
        ...(restoresOfficial
          ? [
              { keyPath: "model_provider", value: "openai" },
              { keyPath: "model", value: null },
            ...(isResponsesProvider(normalizedId) ? [
              { keyPath: "model_catalog_json", value: null },
              { keyPath: "model_reasoning_effort", value: null },
            ] : []),
            ]
          : []),
      ],
    });
  }
  return currentRemovalPlan(preview, await buildRemovalPlan(input, options));
}

function currentRemovalPlan(preview, plan) {
  if (!isDeepStrictEqual(preview, publicRemovalPreview(plan))) {
    throw invalid("stale-preview", "preview", "Provider 状态已变化，请重新生成删除预览");
  }
  return plan;
}

async function buildSwitchPlan(
  { providerId, model },
  {
    environment = process.env,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const normalizedId = normalizeProviderId(providerId, { allowOfficial: true });
  const normalizedModel = optionalString(model);
  const { snapshot, officialModels } = await loadSwitchContext(
    environment,
    createClient,
    normalizedModel !== undefined && !isResponsesProvider(normalizedId),
  );
  if (
    normalizedModel !== undefined
    && !isResponsesProvider(normalizedId)
    && !officialModels.some(
      (candidate) => candidate.available !== false && candidate.model === normalizedModel,
    )
  ) {
    throw invalid(
      "unknown-model",
      "model",
      `模型 ID 不在 Codex 官方模型目录中：${normalizedModel}`,
    );
  }
  const config = record(snapshot.config);
  const providers = record(config.model_providers);
  const currentProvider = optionalString(config.model_provider) ?? "openai";
  const switchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const switching = switchingProviders.find(({ id }) => id === normalizedId);
  if (normalizedId === "openai") {
    const candidateIds = listCustomPrimaryProviderCandidates(providers);
    const removesTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
    const clearsCustomModel = currentProvider !== "openai";
    return {
      target: {
        id: "openai",
        displayName: "OpenAI",
        source: "official",
        ...(normalizedModel === undefined ? {} : { model: normalizedModel }),
      },
      providers,
      expectedVersion: snapshot.version,
      edits: [
        ...(removesTopLevelBaseUrl
          ? [{ keyPath: "openai_base_url", value: null }]
          : []),
        { keyPath: "model_provider", value: "openai" },
        ...(isResponsesProvider(currentProvider) ? [
          { keyPath: "model_catalog_json", value: null },
          { keyPath: "model_reasoning_effort", value: null },
        ] : []),

        ...(normalizedModel !== undefined
          ? [{ keyPath: "model", value: normalizedModel }]
          : clearsCustomModel
            ? [{ keyPath: "model", value: null }]
            : []),
        ...candidateIds.map((id) => ({ keyPath: `model_providers.${id}`, value: null })),
      ],
      effects: {
        currentProviderId: currentProvider,
        restoresFromBackup: false,
        convertsSwitchingProfile: false,
        removesTopLevelBaseUrl,
        clearsCustomModel: clearsCustomModel && normalizedModel === undefined,
        candidateIdsToBackup: candidateIds,
      },
    };
  }
  const otherSwitchingProviderIds = switchingProviders
    .map(({ id }) => id)
    .filter((id) => id !== normalizedId);
  if (otherSwitchingProviderIds.length > 0) {
    throw invalid(
      "other-switching-providers",
      "providerId",
      `固定模式不能保留其他自定义切换 Provider；请先删除其他自定义切换 Provider：${otherSwitchingProviderIds.join("、")}`,
    );
  }
  const candidateIds = listCustomPrimaryProviderCandidates(providers);
  const backup = switching === undefined && !candidateIds.includes(normalizedId)
    ? record(readPrimaryProviderBackup(environment)[normalizedId])
    : {};
  if (!candidateIds.includes(normalizedId) && switching === undefined && typeof backup.base_url !== "string") {
    throw invalid(
      "provider-not-found",
      "providerId",
      `未找到自定义主 Provider：${normalizedId}；可用 codexc provider list 查看候选`,
    );
  }
  const configured = record(providers[normalizedId]);
  const source = switching !== undefined
    ? "switching"
    : candidateIds.includes(normalizedId)
      ? "configured"
      : "backup";
  const provider = source === "switching" ? {
    name: switching.name,
    base_url: switching.baseUrl,
    wire_api: "responses",
    requires_openai_auth: false,
    request_max_retries: thirdPartyProviderRequestMaxRetries,
    stream_max_retries: thirdPartyProviderStreamMaxRetries,
    experimental_bearer_token: switching.apiKey,
    supports_websockets: switching.supportsWebsockets,
  } : source === "configured" ? configured : backup;
  let credential;
  const targetProvider = { ...provider };
  if (provider.env_key !== undefined || provider.experimental_bearer_token !== undefined) {
    const apiKey = readCustomPrimaryProviderApiKey(normalizedId, provider, environment);
    if (apiKey === undefined) throw invalid("api-key-replacement-required", "providerId", "该 Provider 没有可用的独立 API Key，请先编辑 Provider");
    // Existing references retain rotation and account semantics. Only explicit
    // plaintext/Profile conversion needs a new private credential version.
    if (provider.experimental_bearer_token !== undefined) {
      const environmentKey = customPrimaryProviderCredentialEnvironmentKey(normalizedId);
      credential = { providerId: normalizedId, baseUrl: provider.base_url, apiKey, environmentKey };
      targetProvider.env_key = environmentKey;
      delete targetProvider.experimental_bearer_token;
    }
  }
  assertCustomPrimaryProviderAuthentication(targetProvider);
  const custom = isResponsesProvider(normalizedId) ? responsesModelSettings(environment, normalizedId, normalizedModel ?? switching?.model) : undefined;
  const removesTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  return {
    target: {
      id: normalizedId,
      displayName: optionalString(provider.name) ?? normalizedId,
      source,
      baseUrl: optionalString(provider.base_url) ?? "",
      model: custom?.model ?? normalizedModel ?? switching?.model ?? optionalString(config.model) ?? null,
    },
    providers,
    expectedVersion: snapshot.version,
    profileToRemove: switching === undefined ? undefined : normalizedId,
    backupCandidateToRemove: normalizedId,
    credential,
    edits: [
      { keyPath: `model_providers.${normalizedId}`, value: targetProvider },
      ...(removesTopLevelBaseUrl
        ? [{ keyPath: "openai_base_url", value: null }]
        : []),
      { keyPath: "model_provider", value: normalizedId },
      ...(custom ? [
        { keyPath: "model_catalog_json", value: custom.catalog.path },
        { keyPath: "model_reasoning_effort", value: custom.reasoningEffort ?? "none" },
        { keyPath: "model", value: custom.model },
      ] : isResponsesProvider(currentProvider) ? [
        { keyPath: "model_catalog_json", value: null },
        { keyPath: "model_reasoning_effort", value: null },
      ] : []),
      ...(custom || (normalizedModel === undefined && switching === undefined)
        ? []
        : [{ keyPath: "model", value: normalizedModel ?? switching?.model }]),
    ],
    effects: {
      currentProviderId: currentProvider,
      restoresFromBackup: source === "backup",
      convertsSwitchingProfile: source === "switching",
      removesTopLevelBaseUrl,
      clearsCustomModel: false,
      candidateIdsToBackup: [],
    },
  };
}

async function loadSwitchContext(environment, createClient, includeModels) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [snapshot, officialModels] = await Promise.all([
      client.readUserConfigSnapshot(),
      includeModels ? client.listModels() : [],
    ]);
    return { snapshot, officialModels: includeModels && isResponsesProvider(record(snapshot.config).model_provider)
      ? readOfficialModelCatalog(environment).models.filter(model => model.supported_in_api && model.visibility === "list").map(model => ({model: model.slug, available:true}))
      : officialModels };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * 删除只依赖注册表与 Profile 原文：模型目录不可读（例如旧 schema）时仍要能移除该 Provider。
 * 目录可读时沿用完整解析结果，保持既有显示名与内容校验语义。
 */
function registeredSwitchingProviderForRemoval(environment, providerId) {
  if (!loadCustomSwitchingProviderIds(environment).includes(providerId)) return undefined;
  try {
    const [provider] = loadConfiguredCustomSwitchingModelProviders(environment, providerId);
    if (provider !== undefined) return provider;
  } catch {
    // 目录不可读不阻止删除；下面回退到注册表与 Profile 原文。
  }
  let profileContent;
  try {
    profileContent = readPrivateFileSync(customPrimaryProviderProfilePath(environment, providerId));
  } catch {
    return { id: providerId, name: providerId, baseUrl: "", profileContent: undefined };
  }
  let profile;
  try {
    profile = record(parse(profileContent));
  } catch {
    profile = {};
  }
  const block = record(record(profile.model_providers)[providerId]);
  return {
    id: providerId,
    name: optionalString(block.name) ?? providerId,
    baseUrl: optionalString(block.base_url) ?? "",
    profileContent,
  };
}

async function buildRemovalPlan(
  { providerId },
  {
    environment = process.env,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const normalizedId = normalizeProviderId(providerId);
  const switchingProviderIds = loadCustomSwitchingProviderIds(environment);
  if (
    switchingProviderIds.includes(normalizedId)
    && !existsSync(customPrimaryProviderProfilePath(environment, normalizedId))
  ) {
    return {
      target: {
        id: normalizedId,
        displayName: normalizedId,
        baseUrl: "",
        state: "stale-switching",
        active: false,
      },
      activation: "restart-all",
      effects: { restoresOfficial: false },
    };
  }
  const snapshot = await readCodexUserConfigSnapshot(environment, { createClient });
  const config = record(snapshot.config);
  const providers = record(config.model_providers);
  const candidateIds = listCustomPrimaryProviderCandidates(providers);
  const backup = readPrimaryProviderBackup(environment);
  const switching = registeredSwitchingProviderForRemoval(environment, normalizedId);
  const configured = candidateIds.includes(normalizedId);
  const backedUp = Object.prototype.hasOwnProperty.call(backup, normalizedId);
  if (!configured && !backedUp && switching === undefined && isResponsesProvider(normalizedId)) {
    const path = responsesProviderCatalogPath(environment, normalizedId);
    if ([path, `${path}.backup`, `${path}.pending`, responsesProviderBackupPath(environment, normalizedId), customPrimaryProviderProfilePath(environment, normalizedId)].some(path => existsSync(path))) {
      return {
        target: {id: normalizedId, displayName: normalizedId, baseUrl: "", state: "orphan-catalog", active: false},
        activation: "none",
        effects: {restoresOfficial: false},
      };
    }
  }
  if (!configured && !backedUp && switching === undefined) {
    throw invalid(
      "provider-not-found",
      "providerId",
      `未找到自定义主 Provider：${normalizedId}；可用 codexc provider list 查看候选`,
    );
  }
  const state = switching !== undefined ? "switching" : configured ? "configured" : "backup";
  const provider = record(
    configured
      ? providers[normalizedId]
      : switching !== undefined
        ? { name: switching.name, base_url: switching.baseUrl }
        : backup[normalizedId],
  );
  const activeProviderId = optionalString(config.model_provider) ?? "openai";
  const restoresOfficial = configured && activeProviderId === normalizedId;
  return {
    target: {
      id: normalizedId,
      displayName: optionalString(provider.name) ?? normalizedId,
      baseUrl: optionalString(provider.base_url) ?? "",
      state,
      active: restoresOfficial,
    },
    expectedVersion: snapshot.version,
    expectedProfileContent: switching?.profileContent,
    activation: state === "backup" ? "none" : "restart-all",
    effects: { restoresOfficial },
    edits: state === "configured" ? [
      { keyPath: `model_providers.${normalizedId}`, value: null },
      ...(restoresOfficial
        ? [
            { keyPath: "model_provider", value: "openai" },
            { keyPath: "model", value: null },
            ...(isResponsesProvider(normalizedId) ? [
              { keyPath: "model_catalog_json", value: null },
              { keyPath: "model_reasoning_effort", value: null },
            ] : []),
          ]
        : []),
    ] : [],
  };
}

function publicSwitchPreview(plan) {
  return {
    operation: "switch",
    target: plan.target,
    activation: "restart-all",
    effects: plan.effects,
  };
}

function publicRemovalPreview(plan) {
  return {
    operation: "remove",
    target: plan.target,
    activation: plan.activation,
    effects: plan.effects,
  };
}

function removeBackupCandidateSafely(providerId, environment) {
  try {
    removePrimaryProviderBackupCandidate(providerId, environment);
    return true;
  } catch {
    return false;
  }
}

function normalizeProviderId(value, { allowOfficial = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (allowOfficial && normalized === "openai") return normalized;
  const validationError = validateCustomPrimaryModelProviderId(normalized);
  if (validationError !== null) {
    throw invalid("invalid-provider-id", "providerId", validationError);
  }
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
