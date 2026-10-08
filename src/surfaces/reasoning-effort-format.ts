import type { ModelOption } from "../application/index.js";

/** Keep protocol control values unchanged; translate only their presentation. */
export function formatReasoningEffort(
  effort: string | null | undefined,
  fallback = "模型默认",
): string {
  if (effort === "enabled") return "开启思考";
  if (effort === "none") return "关闭思考";
  return effort ?? fallback;
}

export function reasoningEffortSettingName(
  effort: string | null | undefined,
  model?: Pick<ModelOption, "supportedReasoningEfforts">,
): string {
  const toggle = model
    ? model.supportedReasoningEfforts.some((option) => option.effort === "enabled")
    : effort === "enabled" || effort === "none";
  return toggle ? "思考模式" : "思考等级";
}
