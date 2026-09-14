import {
  readManagedModelProviderCatalogContent,
  restoreManagedModelProviderCatalogContent,
  loadManagedModelProviderSettings,
  writeManagedModelProviderCatalogSettings,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";
import {
  areCodexUserConfigEditsApplied,
  readCodexUserConfigSnapshot,
  writeCodexUserConfigEdits,
} from "./codex-user-config.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

export class ModelProviderDefaultManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ModelProviderDefaultManagementError";
    this.code = code;
    this.field = field;
  }
}

export function previewManagedProviderDefaultChange(
  input,
  {
    environment = process.env,
    loadProviders = loadManagedModelProviderSettings,
  } = {},
) {
  return publicPreview(buildPlan(input, loadProviders(environment)));
}

export async function applyManagedProviderDefaultChange(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(
    environment,
    () => applyManagedProviderDefaultChangeUnlocked(input, options),
    { withFileLock: options.withFileLock },
  );
}

async function applyManagedProviderDefaultChangeUnlocked(
  input,
  {
    environment = process.env,
    loadProviders = loadManagedModelProviderSettings,
    writeProfileDefault = writeManagedModelProviderProfileDefault,
    writeCatalogSettings = writeManagedModelProviderCatalogSettings,
    readCatalogContent = readManagedModelProviderCatalogContent,
    restoreCatalogContent = restoreManagedModelProviderCatalogContent,
    writeConfigEdits = writeCodexUserConfigEdits,
    readConfigSnapshot = readCodexUserConfigSnapshot,
  } = {},
) {
  const plan = buildPlan(input, loadProviders(environment));
  try {
    if (plan.provider.mode === "switching") {
      writeProfileDefault(plan.provider.provider, plan.settings, environment);
    } else {
      const edits = exclusiveConfigEdits(plan.model.model);
      const snapshot = await readConfigSnapshot(environment);
      const previousContent = readCatalogContent(plan.provider.provider, environment);
      writeCatalogSettings(plan.provider.provider, plan.settings, environment);
      try {
        await writeConfigEdits(environment, edits, { expectedVersion: snapshot.version });
      } catch (error) {
        let current;
        try {
          current = await readConfigSnapshot(environment);
        } catch (confirmationError) {
          throw new AggregateError(
            [error, confirmationError],
            "Codex 配置写入结果无法确认，模型目录保持新设置",
            { cause: confirmationError },
          );
        }
        if (!areCodexUserConfigEditsApplied(current.config, edits)) {
          try {
            restoreCatalogContent(plan.provider.provider, previousContent, environment);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "第三方模型设置失败，且未能恢复模型目录",
              { cause: rollbackError },
            );
          }
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof ModelProviderDefaultManagementError) throw error;
    throw invalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return {
    action: "updated",
    ...publicPreview(plan),
  };
}

function buildPlan(input, configured) {
  if (!Array.isArray(configured) || configured.length === 0) {
    throw invalid(
      "provider-not-configured",
      "provider",
      "尚未配置第三方 Provider，请先配置 DeepSeek 或 OpenCode Go",
    );
  }
  const values = record(input);
  const providerId = requiredString(values.provider, "provider", "Provider 不能为空");
  const provider = configured.find((candidate) => candidate.provider === providerId);
  if (provider === undefined) {
    throw invalid(
      "provider-not-configured",
      "provider",
      `第三方 Provider 未配置：${providerId}`,
    );
  }
  const modelId = requiredString(values.model, "model", "模型 ID 不能为空");
  const model = provider.models.find((candidate) => candidate.model === modelId);
  if (model === undefined) {
    throw invalid(
      "model-not-supported",
      "model",
      `${provider.displayName} 不支持模型：${modelId}`,
    );
  }
  const reasoningEffort = requiredString(
    values.reasoningEffort,
    "reasoningEffort",
    "思考等级不能为空",
  );
  if (!model.reasoningEfforts.some((candidate) => candidate.effort === reasoningEffort)) {
    throw invalid(
      "reasoning-effort-not-supported",
      "reasoningEffort",
      `${model.displayName} 不支持思考等级：${reasoningEffort}`,
    );
  }
  const windowPercent = values.windowPercent;
  if (
    windowPercent !== undefined
    && (!Number.isInteger(windowPercent)
      || windowPercent < 10
      || windowPercent > 100)
  ) {
    throw invalid(
      "invalid-window-percent",
      "windowPercent",
      `${provider.displayName} 模型上下文窗口百分比无效`,
    );
  }
  const contextWindow = windowPercent === undefined
    ? undefined
    : Math.round(model.maxContextWindow * windowPercent / 100);
  return {
    provider,
    model,
    settings: contextWindow === undefined
      ? { model: model.model, reasoningEffort }
      : { model: model.model, reasoningEffort, contextWindow },
    windowPercent,
    willChange: provider.model !== model.model
      || provider.reasoningEffort !== reasoningEffort
      || (windowPercent !== undefined && model.windowPercent !== windowPercent),
  };
}

function publicPreview(plan) {
  return {
    provider: {
      id: plan.provider.provider,
      displayName: plan.provider.displayName,
      mode: plan.provider.mode,
    },
    model: {
      id: plan.model.model,
      displayName: plan.model.displayName,
      contextWindow: plan.model.contextWindow,
      maxContextWindow: plan.model.maxContextWindow,
    },
    reasoningEffort: plan.settings.reasoningEffort,
    ...(plan.windowPercent === undefined
      ? {}
      : { windowPercent: plan.windowPercent }),
    ...(plan.settings.contextWindow === undefined
      ? {}
      : { contextWindow: plan.settings.contextWindow }),
    willChange: plan.willChange,
    activation: "restart-app-server",
  };
}

function exclusiveConfigEdits(model) {
  return [
    { keyPath: "model", value: model },
    { keyPath: "model_reasoning_effort", value: null },
    { keyPath: "model_context_window", value: null },
    { keyPath: "model_auto_compact_token_limit", value: null },
    { keyPath: "model_auto_compact_token_limit_scope", value: null },
  ];
}

function requiredString(value, field, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") throw invalid("required", field, message);
  return normalized;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function invalid(code, field, message, cause) {
  return new ModelProviderDefaultManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}
