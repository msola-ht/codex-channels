import type { ModelListResponse } from "../codex-protocol/index.js";
import type { ModelOption } from "../application/index.js";

export function toModelOption(model: ModelListResponse["data"][number]): ModelOption | null {
  if (typeof model.hidden !== "boolean") {
    throw new Error("Codex 响应缺少有效 model hidden");
  }
  if (model.hidden) {
    return null;
  }
  requireNonEmptyString(model.id, "model id");
  requireNonEmptyString(model.model, "model name");
  requireNonEmptyString(model.displayName, "model displayName");
  requireNonEmptyString(model.defaultReasoningEffort, "model defaultReasoningEffort");
  if (!Array.isArray(model.supportedReasoningEfforts)) {
    throw new Error("Codex 响应缺少有效 model supportedReasoningEfforts");
  }
  if (!Array.isArray(model.serviceTiers)) {
    throw new Error("Codex 响应缺少有效 model serviceTiers");
  }
  if (model.defaultServiceTier !== null && typeof model.defaultServiceTier !== "string") {
    throw new Error("Codex 响应缺少有效 model defaultServiceTier");
  }
  if (typeof model.isDefault !== "boolean") {
    throw new Error("Codex 响应缺少有效 model isDefault");
  }
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => {
      requireNonEmptyString(option.reasoningEffort, "model reasoning effort");
      if (typeof option.description !== "string") {
        throw new Error("Codex 响应缺少有效 model reasoning effort description");
      }
      return {
        effort: option.reasoningEffort,
        description: option.description,
      };
    }),
    defaultReasoningEffort: model.defaultReasoningEffort,
    serviceTiers: model.serviceTiers.map((tier) => {
      requireNonEmptyString(tier.id, "model service tier id");
      requireNonEmptyString(tier.name, "model service tier name");
      return { id: tier.id, name: tier.name };
    }),
    defaultServiceTier: model.defaultServiceTier,
    isDefault: model.isDefault,
  };
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
}
