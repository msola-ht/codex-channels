import {
  listCustomPrimaryProviderCandidates,
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviderSettings,
  readPrimaryProviderBackup,
} from "../runtime/model-provider-runtime.mjs";
import { agentsStatus } from "./agents.mjs";
import { readCodexUserConfigSnapshot } from "./codex-user-config.mjs";

export async function loadModelProviderManagementState({
  environment = process.env,
  readUserConfig = readCodexUserConfigSnapshot,
  loadManagedProviders = loadManagedModelProviderSettings,
  loadCustomSwitchingProviders = loadConfiguredCustomSwitchingModelProviders,
  listCustomCandidates = listCustomPrimaryProviderCandidates,
  readBackup = readPrimaryProviderBackup,
  loadAgentStatus = agentsStatus,
} = {}) {
  const snapshot = await readUserConfig(environment);
  const config = record(snapshot.config);
  const providerConfig = record(config.model_providers);
  const fixedIds = listCustomCandidates(providerConfig);
  const backup = readBackup(environment);
  const backupIds = Object.keys(backup).filter((id) => !fixedIds.includes(id));
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
      baseUrl: publicBaseUrl(provider.baseUrl),
      profileName: provider.profileName,
    }));
  const fixedCandidates = fixedIds.map((id) => customCandidate(
    id,
    providerConfig[id],
    "configured",
    id === activeId,
  ));
  const backupCandidates = backupIds.map((id) => customCandidate(
    id,
    backup[id],
    "backup",
    id === activeId,
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
      model: optionalString(config.model) ?? null,
      reasoningEffort: optionalString(config.model_reasoning_effort) ?? null,
    },
    primary,
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
    externalAgent: safeAgentStatus(loadAgentStatus(environment)),
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
      reasoningEffort: model.reasoningEffort,
      reasoningEfforts: model.reasoningEfforts.map((entry) => ({ ...entry })),
      ...(model.autoCompactLimit === undefined
        ? {}
        : { autoCompactLimit: model.autoCompactLimit }),
      ...(model.autoCompactPercent === undefined
        ? {}
        : { autoCompactPercent: model.autoCompactPercent }),
    })),
  };
}

function customCandidate(id, value, state, active) {
  const provider = record(value);
  return {
    id,
    displayName: safeDisplayName(provider.name, id),
    kind: "custom",
    state,
    active,
    supportsWebsockets: provider.supports_websockets === true,
    baseUrl: publicBaseUrl(provider.base_url),
  };
}

function safeAgentStatus(status) {
  if (status.provider && status.model) {
    return { status: "configured", provider: status.provider, model: status.model };
  }
  return status.externalRoleConfigured || status.legacyDsRoleConfigured
    ? { status: "unavailable" }
    : { status: "not-configured" };
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
