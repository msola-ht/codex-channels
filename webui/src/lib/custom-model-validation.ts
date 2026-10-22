import { validateSamplingParameters, type SamplingParameters } from "../../../runtime/model-catalog.mjs"
import type { MessageKey } from "@/lib/i18n/messages"

type NumericFields = {
  contextWindow?: number
  maxContextWindow?: number
  effectiveContextWindowPercent?: number
  autoCompactTokenLimit?: number
  truncationPolicy?: { mode: "tokens" | "bytes"; limit: number }
  sampling?: SamplingParameters
}

/** Field feedback for the same numeric constraints enforced by the catalog writer. */
export function customModelNumericErrors(entry: NumericFields): Partial<Record<string, MessageKey>> {
  const errors: Partial<Record<string, MessageKey>> = {}
  for (const [key, value] of Object.entries(entry.sampling ?? {})) {
    try { validateSamplingParameters({ [key]: value }) }
    catch { errors[key] = "customModel.samplingInvalid" }
  }
  const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max
  if (entry.maxContextWindow !== undefined && !integer(entry.maxContextWindow, entry.contextWindow ?? 1024, 100_000_000)) errors.maxContextWindow = "customModel.maxContextInvalid"
  if (entry.effectiveContextWindowPercent !== undefined && !integer(entry.effectiveContextWindowPercent, 1, 100)) errors.effectiveContextWindowPercent = "customModel.effectiveInvalid"
  if (entry.autoCompactTokenLimit !== undefined && (entry.contextWindow === undefined || !integer(entry.autoCompactTokenLimit, 1, Math.floor(entry.contextWindow * 9 / 10)))) errors.autoCompactTokenLimit = "customModel.compactInvalid"
  if (entry.truncationPolicy !== undefined && !integer(entry.truncationPolicy.limit, 1)) errors.truncationPolicy = "customModel.truncationInvalid"
  return errors
}
