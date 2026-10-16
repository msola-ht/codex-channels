import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import { loadProviderModelCatalogs, previewProviderModelRemoval, applyProviderModelRemoval, ProviderModelManagementError } from "./provider-model-management.mjs";
import {
  applyManagedProviderDefaultChange,
  previewManagedProviderDefaultChange,
  ModelProviderDefaultManagementError,
} from "./model-provider-default-management.mjs";
import {
  applyPrimaryProviderRemoval,
  applyPrimaryProviderSwitch,
  previewPrimaryProviderRemoval,
  previewPrimaryProviderSwitch,
  PrimaryProviderManagementError,
} from "./primary-provider-management.mjs";
import {
  applyCustomPrimaryProviderSave,
  previewCustomPrimaryProviderSave,
  previewCustomProviderModelsSave,
  applyCustomProviderModelsSave,
} from "./custom-primary-provider-management.mjs";
import { ManagementOperationError, managementOperationError } from "./webui-management-operations.mjs";
import {
  applyModelWindowChange,
  previewModelWindowChange,
  projectModelWindow,
  ModelWindowManagementError,
} from "./model-window-management.mjs";
import {
  loadManagedModelWindow,
} from "../runtime/model-provider-runtime.mjs";

export async function loadProviderSettingsResource(
  environment,
  loadProviderState = loadModelProviderManagementState,
) {
  try {
    const state = await loadProviderState({ environment });
    return {
      ...projectProviderSettings(state),
      modelCatalogs: (await loadProviderModelCatalogs({ environment })).catalogs,
      modelWindow: projectModelWindow(
        loadManagedModelWindow(environment),
      ),
    };
  } catch {
    throw new ManagementOperationError(
      "provider_state_unavailable",
      "Provider 状态暂不可用",
    );
  }
}

export function normalizeProviderSettingsMutation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ManagementOperationError("invalid_json", "Provider 设置操作正文必须是对象");
  }
  switch (input.operation) {
    case "model.custom.save":
      if (Object.keys(input).some(key => !["operation", "provider", "model", "models", "probeConnections", "resourceRevision", "confirmationToken"].includes(key))) {
        throw new ManagementOperationError("invalid_provider_operation", "模型保存请求包含不支持的字段");
      }
      if (typeof input.resourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.resourceRevision)) {
        throw new ManagementOperationError("stale-preview", "请刷新模型目录后重新编辑");
      }
      return { operation: input.operation, provider: input.provider, model: input.model, models: input.models, resourceRevision: input.resourceRevision,
        ...(input.probeConnections === undefined ? {} : { probeConnections: input.probeConnections }) };
    case "model.remove":
      if (Object.keys(input).some(key => !["operation", "provider", "model", "confirmationToken"].includes(key))) {
        throw new ManagementOperationError("invalid_provider_operation", "模型移除请求包含不支持的字段");
      }
      return { operation: input.operation, provider: input.provider, model: input.model };
    case "primary.switch":
      return {
        operation: input.operation,
        providerId: input.providerId,
        ...(input.model === undefined ? {} : { model: input.model }),
      };
    case "primary.remove":
      return { operation: input.operation, providerId: input.providerId };
    case "primary.custom.save":
      return {
        operation: input.operation,
        provider: {
          operation: input.provider?.operation,
          providerId: input.provider?.providerId,
          name: input.provider?.name,
          baseUrl: input.provider?.baseUrl,
          mode: input.provider?.mode,
          model: input.provider?.model,
          ...(input.provider?.catalog === undefined ? {} : { catalog: input.provider.catalog }),
          supportsWebsockets: input.provider?.supportsWebsockets,
          ...(input.provider?.upstreamWireApi === undefined
            ? {}
            : { upstreamWireApi: input.provider.upstreamWireApi }),
          credential: input.provider?.credential,
          ...(input.provider?.probeConnections === undefined ? {} : { probeConnections: input.provider.probeConnections }),
          ...(input.provider?.confirmRemoveTopLevelBaseUrl === undefined
            ? {}
            : { confirmRemoveTopLevelBaseUrl: input.provider.confirmRemoveTopLevelBaseUrl }),
        },
      };
    case "managed.default":
      return {
        operation: input.operation,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        ...(input.windowPercent === undefined
          ? {}
          : { windowPercent: input.windowPercent }),
      };
    case "managed.window":
      return {
        operation: input.operation,
        model: input.model,
        ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
        ...(input.windowPercent === undefined ? {} : { windowPercent: input.windowPercent }),
      };
    default:
      throw new ManagementOperationError(
        "invalid_provider_operation",
        "Provider 设置操作不受支持",
      );
  }
}

export async function previewProviderSettingsMutation(input, environment) {
  try {
    switch (input.operation) {
      case "model.custom.save":
        return await previewCustomProviderModelsSave(input, { environment });
      case "model.remove":
        return await previewProviderModelRemoval({ provider: input.provider, model: input.model }, { environment });
      case "primary.switch":
        return await previewPrimaryProviderSwitch(
          { providerId: input.providerId, model: input.model },
          { environment },
        );
      case "primary.remove":
        return await previewPrimaryProviderRemoval(
          { providerId: input.providerId },
          { environment },
        );
      case "primary.custom.save":
        return await previewCustomPrimaryProviderSave(input.provider, { environment });
      case "managed.default":
        return {
          operation: "managed.default",
          ...previewManagedProviderDefaultChange(
            {
              provider: input.provider,
              model: input.model,
              reasoningEffort: input.reasoningEffort,
              windowPercent: input.windowPercent,
            },
            { environment },
          ),
        };
      case "managed.window":
        return {
          operation: "managed.window",
          ...previewModelWindowChange(
            input,
            { environment },
          ),
        };
      default:
        throw new ManagementOperationError("invalid_provider_operation", "Provider 设置操作不受支持");
    }
  } catch (error) {
    throw toManagementError(error);
  }
}

export async function applyProviderSettingsMutation(input, environment, preview) {
  try {
    switch (input.operation) {
      case "model.custom.save":
        return await applyCustomProviderModelsSave(input, { environment, preview });
      case "model.remove":
        return await applyProviderModelRemoval({ provider: input.provider, model: input.model }, { environment, preview });
      case "primary.switch":
        return await applyPrimaryProviderSwitch(
          { providerId: input.providerId, model: input.model },
          { environment },
        );
      case "primary.remove":
        return await applyPrimaryProviderRemoval(
          { providerId: input.providerId },
          { environment, preview },
        );
      case "primary.custom.save":
        return await applyCustomPrimaryProviderSave(input.provider, { environment });
      case "managed.default":
        return await applyManagedProviderDefaultChange(
          {
            provider: input.provider,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            windowPercent: input.windowPercent,
          },
          { environment },
        );
      case "managed.window":
        return await applyModelWindowChange(
          input,
          { environment },
        );
      default:
        throw new ManagementOperationError("invalid_provider_operation", "Provider 设置操作不受支持");
    }
  } catch (error) {
    throw toManagementError(error);
  }
}

export function redactProviderSettingsResult(result) {
  if (!result || typeof result !== "object") return { action: "completed" };
  return {
    ...(typeof result.action === "string" ? { action: result.action } : {}),
    ...(typeof result.operation === "string" ? { operation: result.operation } : {}),
    ...(typeof result.revision === "string" ? { revision: result.revision } : {}),
    ...(result.target !== undefined ? { target: redactTarget(result.target) } : {}),
    ...(result.provider !== undefined ? { provider: redactProvider(result.provider) } : {}),
    ...(result.model !== undefined ? { model: redactModel(result.model) } : {}),
    ...(Array.isArray(result.providers)
      ? { providers: result.providers.filter((value) => typeof value === "string") }
      : {}),
    ...(result.reasoningEffort !== undefined ? { reasoningEffort: result.reasoningEffort } : {}),
    ...(result.windowPercent !== undefined ? { windowPercent: result.windowPercent } : {}),
    ...(result.contextWindow !== undefined ? { contextWindow: result.contextWindow } : {}),
    ...(result.willChange !== undefined ? { willChange: result.willChange } : {}),
    ...(result.effects !== undefined ? { effects: result.effects } : {}),
    ...(result.transport && typeof result.transport === "object"
      ? {
          transport: {
            ...(result.transport.scheme === "http" || result.transport.scheme === "https"
              ? { scheme: result.transport.scheme }
              : {}),
            ...(typeof result.transport.cleartext === "boolean"
              ? { cleartext: result.transport.cleartext }
              : {}),
          },
        }
      : {}),
    ...(result.credential && typeof result.credential === "object"
      ? {
          credential: {
            ...(result.credential.action === "preserve" || result.credential.action === "replace"
              ? { action: result.credential.action }
              : {}),
            ...(result.credential.storedAsPlaintext === true ? { storedAsPlaintext: true } : {}),
            ...(result.credential.destination === "private-profile" || result.credential.destination === "private-credential"
              ? { destination: result.credential.destination }
              : {}),
          },
        }
      : {}),
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    ...(result.activation !== undefined ? { activation: result.activation } : {}),
  };
}

export function projectProviderSettings(state) {
  return {
    configVersion: state.configVersion ?? null,
    defaults: {
      model: state.defaults.model ?? null,
      reasoningEffort: state.defaults.reasoningEffort ?? null,
    },
    primary: redactTarget(state.primary),
    managedProviders: state.managedProviders.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName ?? provider.id,
      mode: provider.mode ?? "switching",
      model: provider.model ?? "",
      reasoningEffort: provider.reasoningEffort ?? "",
      models: (provider.models ?? []).map((model) => ({
        id: model.id,
        displayName: model.displayName ?? model.id,
        contextWindow: model.contextWindow ?? 0,
        maxContextWindow: model.maxContextWindow ?? 0,
        reasoningEffort: model.reasoningEffort ?? "",
        reasoningEfforts: model.reasoningEfforts ?? [],
        ...(model.windowPercent === undefined ? {} : { windowPercent: model.windowPercent }),
      })),
    })),
    customProviders: {
      fixedCandidates: state.customProviders.fixedCandidates.map(redactTarget),
      switchingProviders: state.customProviders.switchingProviders.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName ?? provider.id,
        mode: provider.mode ?? "switching",
        model: provider.model ?? "",
        reasoningEffort: provider.reasoningEffort ?? null,
        baseUrl: provider.baseUrl ?? "",
        supportsWebsockets: provider.supportsWebsockets === true,
        upstreamWireApi: provider.upstreamWireApi,
        ...redactCatalog(provider),
      })),
      backupCandidates: state.customProviders.backupCandidates.map(redactTarget),
    },
  };
}

function redactTarget(target) {
  return {
    id: target.id,
    displayName: target.displayName ?? target.id,
    ...redactCatalog(target),
    ...(target.kind === undefined ? {} : { kind: target.kind }),
    ...(target.source === undefined ? {} : { source: target.source }),
    ...(target.state === undefined ? {} : { state: target.state }),
    ...(target.mode === undefined ? {} : { mode: target.mode }),
    ...(target.active === undefined ? {} : { active: target.active }),
    ...(target.supportsWebsockets === undefined ? {} : { supportsWebsockets: target.supportsWebsockets }),
    ...(target.upstreamWireApi === undefined ? {} : { upstreamWireApi: target.upstreamWireApi }),
    ...(target.baseUrl === undefined ? {} : { baseUrl: target.baseUrl }),
    ...(target.model === undefined ? {} : { model: target.model }),
  };
}

function redactProvider(provider) {
  if (provider === null || typeof provider !== "object") return provider;
  return {
    ...(provider.id === undefined ? {} : { id: provider.id }),
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    ...(provider.name === undefined ? {} : { name: provider.name }),
    ...(provider.model === undefined ? {} : { model: provider.model }),
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.mode === undefined ? {} : { mode: provider.mode }),
    ...(provider.upstreamWireApi === "responses" || provider.upstreamWireApi === "chat_completions"
      ? { upstreamWireApi: provider.upstreamWireApi }
      : {}),
    ...redactCatalog(provider),
    ...(provider.hasApiKey === undefined ? {} : { hasApiKey: provider.hasApiKey }),
  };
}

function redactModel(model) {
  if (model === null || typeof model !== "object") return model;
  return {
    ...(model.id === undefined ? {} : { id: model.id }),
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  };
}

function toManagementError(error) {
  return managementOperationError(error, [PrimaryProviderManagementError, ModelProviderDefaultManagementError, ModelWindowManagementError, ProviderModelManagementError], "provider_settings_failed");
}

function redactCatalog(provider) {
  if (provider.catalog !== "custom") return provider.catalog === undefined ? {} : { catalog: provider.catalog };
  // Loaded catalogs and save previews already contain strict ModelDefinition values.
  // Clone the whole definition so a new capability cannot disappear at this boundary.
  return { catalog: "custom", models: structuredClone(provider.models ?? []) };
}
