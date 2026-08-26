import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  backupPrimaryProviderCandidates,
  customPrimaryProviderProfilePath,
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  loadCustomSwitchingProviderIds,
  readPrimaryProviderBackup,
  removeCustomPrimaryProviderSwitchingProfile,
  removePrimaryProviderBackupCandidate,
  restorePrimaryProviderCandidateEdits,
  validateCustomPrimaryModelProviderId,
} from "../runtime/model-provider-runtime.mjs";
import { modelProviderBlockEdits } from "../runtime/model-provider-profile.mjs";
import {
  createCodexUserConfigClient,
  readCodexUserConfigSnapshot,
} from "./codex-user-config.mjs";
import { assertThirdPartyRoleDoesNotUseProvider } from "./agents.mjs";
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
  if (plan.target.state === "stale-switching") {
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
  return {
    action: "removed",
    target: plan.target,
    activation: plan.activation,
    effects: plan.effects,
    warnings: backupCleaned
      ? []
      : [{ code: "backup-cleanup-failed", providerId: plan.target.id }],
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
  assertProviderNotInUse(normalizedId, environment);
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
    const switching = loadConfiguredCustomSwitchingModelProviders(environment)
      .find(({ id }) => id === normalizedId);
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
    if (loadConfiguredCustomSwitchingModelProviders(environment).some(({ id }) => id === normalizedId)) {
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
    normalizedModel !== undefined,
  );
  if (
    normalizedModel !== undefined
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
    if (currentProvider !== "openai") {
      assertProviderNotInUse(currentProvider, environment);
    }
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
  if (currentProvider !== "openai" && currentProvider !== normalizedId) {
    assertProviderNotInUse(currentProvider, environment);
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
  const switchingEdits = switching === undefined
    ? []
    : modelProviderBlockEdits(normalizedId, {
        name: switching.name,
        base_url: switching.baseUrl,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: switching.supportsWebsockets,
        experimental_bearer_token: switching.apiKey,
      });
  const restoreEdits = candidateIds.includes(normalizedId)
    ? []
    : switchingEdits.length > 0
      ? switchingEdits
      : restorePrimaryProviderCandidateEdits(normalizedId, environment) ?? [];
  if (!candidateIds.includes(normalizedId) && restoreEdits.length === 0) {
    throw invalid(
      "provider-not-found",
      "providerId",
      `未找到自定义主 Provider：${normalizedId}；可用 codexc primary-provider list 查看候选`,
    );
  }
  const backup = switching === undefined && !candidateIds.includes(normalizedId)
    ? record(readPrimaryProviderBackup(environment)[normalizedId])
    : {};
  const configured = record(providers[normalizedId]);
  const source = switching !== undefined
    ? "switching"
    : candidateIds.includes(normalizedId)
      ? "configured"
      : "backup";
  const provider = source === "switching" ? {
    name: switching.name,
    base_url: switching.baseUrl,
  } : source === "configured" ? configured : backup;
  const removesTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  return {
    target: {
      id: normalizedId,
      displayName: optionalString(provider.name) ?? normalizedId,
      source,
      baseUrl: optionalString(provider.base_url) ?? "",
      model: normalizedModel ?? switching?.model ?? optionalString(config.model) ?? null,
    },
    providers,
    expectedVersion: snapshot.version,
    profileToRemove: switching === undefined ? undefined : normalizedId,
    backupCandidateToRemove: normalizedId,
    edits: [
      ...restoreEdits,
      ...(removesTopLevelBaseUrl
        ? [{ keyPath: "openai_base_url", value: null }]
        : []),
      { keyPath: "model_provider", value: normalizedId },
      ...(normalizedModel === undefined && switching === undefined
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
    return { snapshot, officialModels };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function buildRemovalPlan(
  { providerId },
  {
    environment = process.env,
    createClient = createCodexUserConfigClient,
  } = {},
) {
  const normalizedId = normalizeProviderId(providerId);
  assertProviderNotInUse(normalizedId, environment);
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
  const switching = loadConfiguredCustomSwitchingModelProviders(environment)
    .find(({ id }) => id === normalizedId);
  const configured = candidateIds.includes(normalizedId);
  const backedUp = Object.prototype.hasOwnProperty.call(backup, normalizedId);
  if (!configured && !backedUp && switching === undefined) {
    throw invalid(
      "provider-not-found",
      "providerId",
      `未找到自定义主 Provider：${normalizedId}；可用 codexc primary-provider list 查看候选`,
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
