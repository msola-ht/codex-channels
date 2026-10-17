export type ContextWindowPreset = "272000" | "372000" | "500000" | "max" | "custom"

export function contextWindowPreset(value: number | null, maximum: number | null): ContextWindowPreset {
  if (value === 272000 || value === 372000 || value === 500000) return String(value) as ContextWindowPreset
  return value !== null && value === maximum ? "max" : "custom"
}

export function validContextWindow(value: string, minimum: number, maximum: number | null): boolean {
  const tokens = /^[1-9]\d*$/u.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(tokens) && tokens >= minimum && (maximum === null || tokens <= maximum)
}
