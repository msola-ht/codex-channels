import { isCustomCatalogProvider, readResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { hasCodexAuthFile } from "../runtime/codex-home.mjs";
import {
  listCustomPrimaryProviderCandidates,
  validateCustomPrimaryModelProviderId,
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviderSettings,
  readPrimaryProviderBackup,
} from "../runtime/model-provider-runtime.mjs";
import { readCodexUserConfigSnapshot } from "./codex-user-config.mjs";
import { ProviderWebSearchSettingsError, readProviderWebSearchConfig } from "../runtime/provider-web-search.mjs";

/** Display each exact provider's override; null explicitly means follow global. */
export function loadProviderWebSearchSettings(state, environment = process.env) {
  return [{ provider: "openai", source: "global", status: "ready", mode: state.defaults.webSearch }, ...configuredWebSearchProviders(state).map(provider => {
    try {
      const { source, mode } = readProviderWebSearchConfig(provider, environment);
      return { provider, source, status: "ready", mode };
    }
    catch (error) {
      return { provider, source: "provider", status: "error", error: error instanceof ProviderWebSearchSettingsError ? error.code : "unreadable" };
    }
  })];
}

export function configuredWebSearchProviders(state) {
  return [...new Set([...state.managedProviders.map(provider => provider.id),
    ...state.customProviders.fixedCandidates.map(provider => provider.id),
    ...state.customProviders.switchingProviders.map(provider => provider.id)])];
}

export async function loadModelProviderManagementState({
  environment = process.env,
  readUserConfig = readCodexUserConfigSnapshot,
  loadManagedProviders = loadManagedModelProviderSettings,
  loadCustomSwitchingProviders = loadConfiguredCustomSwitchingModelProviders,
  listCustomCandidates = listCustomPrimaryProviderCandidates,
  readBackup = readPrimaryProviderBackup,
  checkOfficialAuth = hasCodexAuthFile,
} = {}) {
  const snapshot = await readUserConfig(environment);
  const config = record(snapshot.config);
  const providerConfig = record(config.model_providers);
  const fixedIds = listCustomCandidates(providerConfig);
  const backup = readBackup(environment);
  const backupIds = Object.keys(backup).filter((id) => !fixedIds.includes(id));
  for (const id of backupIds) {
    if (validateCustomPrimaryModelProviderId(id, environment) !== null) {
      throw new Error("主 Provider 备份包含不受支持的 ID；自定义提供商必须使用 cp- 前缀");
    }
  }
  const activeId = optionalString(config.model_provider) ?? "openai";
  const managedProviders = loadManagedProviders(environment).map(safeManagedProvider);
  const customSwitchingProviders = loadCustomSwitchingProviders(environment)
    .map((provider) => ({
      id: provider.id,
      displayName: safeDisplayName(provider.name, provider.id),
      kind: "custom",
      mode: "switching",
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
      supportsWebsockets: provider.supportsWebsockets,
      upstreamWireApi: provider.upstreamWireApi,
      baseUrl: publicBaseUrl(provider.baseUrl),
      profileName: provider.profileName,
      ...customCatalog(provider.id, environment, provider.model),
    }));
  const fixedCandidates = fixedIds.map((id) => customCandidate(
    id,
    providerConfig[id],
    "configured",
    id === activeId,
    environment,
    id === activeId ? optionalString(config.model) : undefined,
  ));
  const backupCandidates = backupIds.map((id) => customCandidate(
    id,
    backup[id],
    "backup",
    id === activeId,
    environment,
  ));
  const exclusiveManaged = managedProviders.find((provider) => provider.mode === "exclusive");
  const primary = exclusiveManaged === undefined
    ? activeId === "openai"
      ? { id: "openai", displayName: "OpenAI 官方", kind: "official", mode: "official" }
      : fixedCandidates.some((provider) => provider.id === activeId)
        ? {
            id: activeId,
            displayName: fixedCandidates.find((provider) => provider.id === activeId).displayName,
            kind: "custom",
            mode: "exclusive",
          }
        : backupCandidates.some((provider) => provider.id === activeId)
          ? {
              id: activeId,
              displayName: backupCandidates.find((provider) => provider.id === activeId).displayName,
              kind: "custom",
              mode: "backup",
            }
          : { id: activeId, displayName: activeId, kind: "unknown", mode: "unknown" }
    : {
        id: exclusiveManaged.id,
        displayName: exclusiveManaged.displayName,
        kind: "managed",
        mode: "exclusive",
      };
  return {
    configVersion: snapshot.version,
    defaults: {
      webSearch: config.web_search ?? null,
      model: optionalString(config.model) ?? null,
      reasoningEffort: optionalString(config.model_reasoning_effort) ?? null,
    },
    primary,
    officialAuth: {
      authenticated: checkOfficialAuth(environment),
    },
    managedProviders,
    customProviders: {
      fixedCandidates,
      switchingProviders: customSwitchingProviders,
      backupCandidates,
    },
    switchingProviders: [
      ...managedProviders.filter((provider) => provider.mode === "switching"),
      ...customSwitchingProviders,
    ],
  };
}

function safeManagedProvider(provider) {
  return {
    id: provider.provider,
    displayName: provider.displayName,
    kind: "managed",
    mode: provider.mode,
    model: provider.model,
    reasoningEffort: provider.reasoningEffort,
    models: provider.models.map((model) => ({
      id: model.model,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxContextWindow: model.maxContextWindow,
      reasoningEffort: model.reasoningEffort,
      reasoningEfforts: model.reasoningEfforts.map((entry) => ({ ...entry })),
      ...(model.windowPercent === undefined
        ? {}
        : { windowPercent: model.windowPercent }),
    })),
  };
}

function customCandidate(id, value, state, active, environment, model) {
  const provider = record(value);
  return {
    id,
    displayName: safeDisplayName(provider.name, id),
    kind: "custom",
    state,
    active,
    ...customCatalog(id, environment, model),
    ...customUpstreamWireApi(id, environment),
    supportsWebsockets: provider.supports_websockets === true,
    baseUrl: publicBaseUrl(provider.base_url),
  };
}

/**
 * 已保存的上游接口；缺失按 responses。元数据不可安全读取时省略该字段，
 * 让编辑流程按“沿用已保存值”处理，而不是静默当作 responses。
 */
function customUpstreamWireApi(id, environment) {
  if (!isCustomCatalogProvider(id)) return {};
  try {
    return { upstreamWireApi: readCustomProviderUpstreamWireApi(environment, id) };
  } catch {
    return {};
  }
}

function publicBaseUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeDisplayName(value, fallback) {
  const normalized = typeof value === "string"
    ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim()
    : "";
  return (normalized || fallback).slice(0, 120);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function customCatalog(id, environment, model) {
  if (!isCustomCatalogProvider(id)) return {};
  const catalog = readResponsesModelCatalog(environment, id);
  return { catalog: "custom", models: catalog.definitions, model: model ?? catalog.defaultModel };
}
