import {
  loadManagedModelWindow,
  writeManagedModelWindow,
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

export async function applyModelWindowChange(
  input,
  {
    environment = process.env,
    loadWindow = loadManagedModelWindow,
    writeWindow = writeManagedModelWindow,
    withFileLock,
  } = {},
) {
  return withModelProviderManagementTransaction(
    environment,
    () => {
      const plan = buildPlan(input, loadWindow(environment));
      try {
        writeWindow({
          provider: plan.model.provider,
          model: plan.model.model,
          contextWindow: plan.contextWindow,
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
  const provider = requiredString(values.provider, "provider", "Provider ID 不能为空");
  const modelId = requiredString(values.model, "model", "模型 ID 不能为空");
  const model = models.find((candidate) => candidate.provider === provider && candidate.model === modelId);
  if (model === undefined) {
    throw invalid(
      "model-not-supported",
      "model",
      `未找到已配置模型：${provider}/${modelId}`,
    );
  }
  const hasContext = values.contextWindow !== undefined;
  if (hasContext && values.windowPercent !== undefined) {
    throw invalid("invalid-window", "contextWindow", "Token 数和窗口百分比不能同时设置");
  }
  if (!hasContext && (!Number.isInteger(values.windowPercent)
    || values.windowPercent < 10 || values.windowPercent > 100)) {
    throw invalid(
      "invalid-window-percent",
      "windowPercent",
      `模型上下文窗口百分比无效：${model.displayName}`,
    );
  }
  const contextWindow = hasContext ? values.contextWindow
    : Math.round(model.maxContextWindow * values.windowPercent / 100);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > model.maxContextWindow) {
    throw invalid("invalid-window", "contextWindow", `模型上下文窗口必须是 1024-${model.maxContextWindow} 的整数：${model.displayName}`);
  }
  const windowPercent = contextWindow * 100 / model.maxContextWindow;
  return {
    model,
    windowPercent,
    contextWindow,
    willChange: model.contextWindow !== contextWindow,
  };
}

function publicPreview(plan) {
  return {
    provider: plan.model.provider,
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
    activation: "restart-app-server",
  };
}

function requiredString(value, field, message) {
  if (typeof value !== "string" || value.trim() === "") throw invalid("required", field, message);
  return value;
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
