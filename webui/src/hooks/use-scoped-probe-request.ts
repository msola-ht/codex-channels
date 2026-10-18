import { useCallback, useEffect, useRef } from "react"

/** Owns one user-initiated request; payloads and result validation stay with callers. */
export function useScopedProbeRequest(key: string, enabled: boolean, reset: () => void) {
  const active = useRef<AbortController | null>(null)
  const current = useRef({ key, enabled })
  current.current = { key, enabled }

  const cancel = useCallback(() => {
    const controller = active.current
    active.current = null
    controller?.abort()
  }, [])
  const invalidate = useCallback(() => {
    cancel()
    reset()
  }, [cancel, reset])
  useEffect(() => {
    invalidate()
    return cancel
  }, [key, enabled, invalidate, cancel])

  const begin = () => {
    if (!enabled || !current.current.enabled || current.current.key !== key || active.current !== null) return null
    const controller = new AbortController()
    active.current = controller
    return controller
  }
  const owns = (controller: AbortController) => active.current === controller
    && !controller.signal.aborted && current.current.enabled && current.current.key === key
  const finish = (controller: AbortController) => {
    if (active.current === controller) active.current = null
  }
  return { begin, owns, finish, cancel, invalidate }
}
