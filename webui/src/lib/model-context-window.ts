import { contextWindowPresetTokens, openAiContextWindowPresetTokens } from "../../../runtime/model-catalog.mjs"

export type ContextWindowPresetGroup = "openai" | "third-party"
export type ContextWindowPreset = `${typeof contextWindowPresetTokens[number] | typeof openAiContextWindowPresetTokens[number]}` | "max" | "custom"

export function contextWindowPresets(group: ContextWindowPresetGroup): readonly number[] {
  return group === "openai" ? openAiContextWindowPresetTokens : contextWindowPresetTokens
}

export function isContextWindowPreset(value: string, group: ContextWindowPresetGroup): value is ContextWindowPreset {
  return value === "max" || value === "custom" || contextWindowPresets(group).some(tokens => String(tokens) === value)
}

export function contextWindowPreset(value: number | null, maximum: number | null, group: ContextWindowPresetGroup): ContextWindowPreset {
  if (contextWindowPresets(group).some(tokens => tokens === value)) return String(value) as ContextWindowPreset
  return value !== null && value === maximum ? "max" : "custom"
}

export function validContextWindow(value: string, minimum: number, maximum: number | null): boolean {
  const tokens = /^[1-9]\d*$/u.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(tokens) && tokens >= minimum && (maximum === null || tokens <= maximum)
}
