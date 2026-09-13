import {
  loadManagedModelWindow,
  writeManagedModelWindowGlobal,
} from "../runtime/model-provider-runtime.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

export class ModelWindowManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ModelWindowManagementError";
    this.code = code;
    this.field = field;
  }
}

export function previewModelWindowChange(
  input,
  {
    environment = process.env,
    loadWindow = loadManagedModelWindow,
  } = {},
) {
  return publicPreview(buildPlan(input, loadWindow(environment)));
}

export async function applyModelWindowChange(
  input,
  {
    environment = process.env,
    loadWindow = loadManagedModelWindow,
    writeWindow = writeManagedModelWindowGlobal,
    withFileLock,
  } = {},
) {
  return withModelProviderManagementTransaction(
    environment,
    () => {
      const plan = buildPlan(input, loadWindow(environment));
      try {
        writeWindow({
          model: plan.model.model,
          windowPercent: plan.windowPercent,
          environment,
        });
      } catch (error) {
        if (error instanceof ModelWindowManagementError) throw error;
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
      "尚未配置受管第三方 Provider，无法设置模型上下文窗口",
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
      `同名模型在不同 Provider 的最大上下文窗口不一致：${model.displayName}`,
    );
  }
  const windowPercent = values.windowPercent;
  if (
    !Number.isInteger(windowPercent)
    || windowPercent < 10
    || windowPercent > 100
  ) {
    throw invalid(
      "invalid-window-percent",
      "windowPercent",
      `模型上下文窗口百分比无效：${model.displayName}`,
    );
  }
  const contextWindow = Math.round(
    model.maxContextWindow * windowPercent / 100,
  );
  const overridden = Object.entries(model.perProvider ?? {}).flatMap(
    ([provider, value]) => (
      value !== undefined && value !== windowPercent
        ? [{ provider, previousPercent: value }]
        : []
    ),
  );
  return {
    model,
    windowPercent,
    contextWindow,
    willChange: model.windowPercent !== windowPercent || overridden.length > 0,
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
      maxContextWindow: plan.model.maxContextWindow,
    },
    windowPercent: plan.windowPercent,
    contextWindow: plan.contextWindow,
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
  return new ModelWindowManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function projectModelWindow(models) {
  return models.map((model) => ({
    id: model.model,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxContextWindow: model.maxContextWindow,
    providers: model.providers,
    ...(model.windowPercent === undefined
      ? {}
      : { windowPercent: model.windowPercent }),
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
