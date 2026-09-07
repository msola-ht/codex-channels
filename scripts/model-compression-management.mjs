import {
  loadManagedModelCompression,
  writeManagedModelCompressionGlobal,
} from "../runtime/model-provider-runtime.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

export class ModelCompressionManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ModelCompressionManagementError";
    this.code = code;
    this.field = field;
  }
}

export function previewModelCompressionChange(
  input,
  {
    environment = process.env,
    loadCompression = loadManagedModelCompression,
  } = {},
) {
  return publicPreview(buildPlan(input, loadCompression(environment)));
}

export async function applyModelCompressionChange(
  input,
  {
    environment = process.env,
    loadCompression = loadManagedModelCompression,
    writeCompression = writeManagedModelCompressionGlobal,
    withFileLock,
  } = {},
) {
  return withModelProviderManagementTransaction(
    environment,
    () => {
      const plan = buildPlan(input, loadCompression(environment));
      try {
        writeCompression({
          model: plan.model.model,
          autoCompactPercent: plan.autoCompactPercent,
          environment,
        });
      } catch (error) {
        if (error instanceof ModelCompressionManagementError) throw error;
        throw invalid(
          "operation-failed",
          "model",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      return {
        action: "updated",
        ...publicPreview(plan),
      };
    },
    { withFileLock },
  );
}

function buildPlan(input, models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw invalid(
      "model-not-configured",
      "model",
      "尚未配置受管第三方 Provider，无法设置模型自动压缩",
    );
  }
  const values = record(input);
  const modelId = requiredString(values.model, "model", "模型 ID 不能为空");
  const model = models.find((candidate) => candidate.model === modelId);
  if (model === undefined) {
    throw invalid(
      "model-not-supported",
      "model",
      `未找到已配置模型：${modelId}`,
    );
  }
  if (model.windowConflict === true) {
    throw invalid(
      "window-conflict",
      "model",
      `同名模型在不同 Provider 的上下文窗口不一致：${model.displayName}`,
    );
  }
  const autoCompactPercent = values.autoCompactPercent;
  if (
    !Number.isInteger(autoCompactPercent)
    || autoCompactPercent < 10
    || autoCompactPercent > 90
  ) {
    throw invalid(
      "invalid-auto-compact-percent",
      "autoCompactPercent",
      `模型自动压缩百分比无效：${model.displayName}`,
    );
  }
  const autoCompactLimit = Math.round(
    model.contextWindow * autoCompactPercent / 100,
  );
  const overridden = Object.entries(model.perProvider ?? {}).flatMap(
    ([provider, value]) => (
      value !== undefined && value !== autoCompactPercent
        ? [{ provider, previousPercent: value }]
        : []
    ),
  );
  return {
    model,
    autoCompactPercent,
    autoCompactLimit,
    willChange: model.autoCompactPercent !== autoCompactPercent,
    conflicts: model.conflicts === true,
    overridden,
  };
}

function publicPreview(plan) {
  return {
    model: {
      id: plan.model.model,
      displayName: plan.model.displayName,
      contextWindow: plan.model.contextWindow,
    },
    autoCompactPercent: plan.autoCompactPercent,
    autoCompactLimit: plan.autoCompactLimit,
    providers: plan.model.providers,
    willChange: plan.willChange,
    conflicts: plan.conflicts,
    overridden: plan.overridden,
    windowConflict: plan.model.windowConflict === true,
    activation: "restart-app-server",
  };
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
  return new ModelCompressionManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function projectModelCompression(models) {
  return models.map((model) => ({
    id: model.model,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    providers: model.providers,
    ...(model.autoCompactPercent === undefined
      ? {}
      : { autoCompactPercent: model.autoCompactPercent }),
    conflicts: model.conflicts === true,
    windowConflict: model.windowConflict === true,
    ...(model.perProvider === undefined
      ? {}
      : {
          perProvider: Object.fromEntries(
            Object.entries(model.perProvider).filter(([, value]) => value !== undefined),
          ),
        }),
  }));
}
