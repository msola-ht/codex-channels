import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import {
  applyManagedProviderDefaultChange,
  previewManagedProviderDefaultChange,
} from "./model-provider-default-management.mjs";
import {
  applyPrimaryProviderRemoval,
  applyPrimaryProviderSwitch,
  previewPrimaryProviderRemoval,
  previewPrimaryProviderSwitch,
} from "./primary-provider-management.mjs";
import {
  applyCustomPrimaryProviderSave,
  previewCustomPrimaryProviderSave,
} from "./custom-primary-provider-management.mjs";
import { ManagementOperationError } from "./webui-management-operations.mjs";
import {
  applyModelWindowChange,
  previewModelWindowChange,
  projectModelWindow,
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
          credential: input.provider?.credential,
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
        windowPercent: input.windowPercent,
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
            {
              model: input.model,
              windowPercent: input.windowPercent,
            },
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
          {
            model: input.model,
            windowPercent: input.windowPercent,
          },
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
    ...(result.credential && typeof result.credential === "object"
      ? {
          credential: {
            ...(result.credential.action === "preserve" || result.credential.action === "replace"
              ? { action: result.credential.action }
              : {}),
            ...(result.credential.storedAsPlaintext === true ? { storedAsPlaintext: true } : {}),
            ...(result.credential.destination === "private-profile" || result.credential.destination === "main-config"
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
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    ...(provider.mode === undefined ? {} : { mode: provider.mode }),
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
  if (error instanceof ManagementOperationError) return error;
  return new ManagementOperationError(
    typeof error?.code === "string" ? error.code : "provider_settings_failed",
    error instanceof Error ? error.message : "Provider 设置操作失败",
    error?.field,
  );
}

function redactCatalog(provider) {
  if (provider.catalog !== "custom") return provider.catalog === undefined ? {} : { catalog: provider.catalog };
  return { catalog: "custom", models: (provider.models ?? []).map((model) => ({
    id: model.id, name: model.name, contextWindow: model.contextWindow,
    ...(model.maxContextWindow === undefined ? {} : {maxContextWindow: model.maxContextWindow}),
    reasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort,
    supportsImages: model.supportsImages,
    ...(model.applyPatchToolType === undefined ? {} : {applyPatchToolType: model.applyPatchToolType}),
    ...(model.instructions === undefined ? {} : {instructions: model.instructions}),
    ...(model.supportsSearchTool === undefined ? {} : {supportsSearchTool: model.supportsSearchTool}),
    ...(model.template === undefined ? {} : {template: structuredClone(model.template)}),
  })) };
}
