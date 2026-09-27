export type SettingsLoadState = "loading" | "error" | "empty" | "ready"

export function resolveSettingsLoadState(
  settings: unknown | null,
  loading: boolean,
  error: string | null,
): SettingsLoadState {
  if (settings !== null) return "ready"
  if (error !== null) return "error"
  if (loading) return "loading"
  return "empty"
}

export function reconcileSettingsDraft<T extends Record<string, string>>(source: T, edits: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(edits).filter(([key, value]) => value !== source[key])) as Partial<T>
}
