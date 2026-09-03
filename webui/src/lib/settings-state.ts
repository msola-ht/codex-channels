import type { SettingsResponse } from "./types.js"

export type SettingsLoadState = "loading" | "error" | "empty" | "ready"

export function resolveSettingsLoadState(
  settings: SettingsResponse | null,
  loading: boolean,
  error: string | null,
): SettingsLoadState {
  if (error !== null) return "error"
  if (loading) return "loading"
  return settings === null ? "empty" : "ready"
}
