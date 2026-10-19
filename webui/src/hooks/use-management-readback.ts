import { useCallback, useEffect, useState } from "react"
import { ApiClientError } from "@/lib/api"

export function isUnconfirmedManagementWrite(error: unknown): boolean {
  return !(error instanceof ApiClientError)
    || (error.status >= 500 && error.code !== "management_audit_unavailable")
}

/** A fresh successful read unlocks edits; it does not confirm the previous write. */
export function useManagementReadback<Snapshot>(request: {
  data: Snapshot | null
  loading: boolean
  error: string | null
}) {
  const [writeUnconfirmed, setWriteUnconfirmed] = useState(false)
  const [pending, setPending] = useState<{ baseline: Snapshot | null } | null>(null)
  const { data, loading, error } = request

  useEffect(() => {
    if (pending !== null && data !== null && data !== pending.baseline && !loading && error === null) {
      setPending(null)
    }
  }, [data, loading, error, pending])

  const requireReadback = useCallback((baseline: Snapshot | null, unconfirmed: boolean) => {
    setWriteUnconfirmed(unconfirmed)
    setPending({ baseline })
  }, [])

  return { writeUnconfirmed, readbackRequired: pending !== null, requireReadback }
}
