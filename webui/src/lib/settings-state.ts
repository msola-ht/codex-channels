export type SettingsLoadState = "loading" | "error" | "empty" | "ready"

export function resolveSettingsLoadState(
  settings: unknown | null,
  loading: boolean,
  error: string | null,
): SettingsLoadState {
  if (error !== null) return "error"
  if (settings !== null) return "ready"
  if (loading) return "loading"
  return "empty"
}
