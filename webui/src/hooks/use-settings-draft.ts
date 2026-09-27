import { useCallback, useState } from "react"
import { reconcileSettingsDraft } from "@/lib/settings-state"

/** 未编辑字段跟随快照；已编辑字段只在值被服务端确认或显式重置后释放。 */
export function useSettingsDraft<K extends string>(source: Record<K, string>) {
  const [edits, setEdits] = useState<Partial<Record<K, string>>>({})
  const current = reconcileSettingsDraft(source, edits)
  if (Object.keys(current).length !== Object.keys(edits).length) setEdits(current)
  const patch = useCallback((changes: Partial<Record<K, string>>) => setEdits((previous) => ({ ...previous, ...changes })), [])
  const reset = useCallback(() => setEdits({}), [])
  return [{ ...source, ...current } as Record<K, string>, patch, reset] as const
}
