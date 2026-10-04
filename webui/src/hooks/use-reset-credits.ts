import { useEffect, useRef, useState } from "react"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { ApiClientError, cancelResetCredit, consumeResetCredit, fetchResetCredits, previewResetCredit, refreshOfficialAccountSnapshot } from "@/lib/api"
import type { ResetCreditPreview, ResetCreditResult } from "@/lib/types"
import type { MessageKey } from "@/lib/i18n/messages"

const applyReset = async (_input: { creditId: string }, token: string, signal: AbortSignal | undefined, preview: ResetCreditPreview) =>
  consumeResetCredit(preview.attemptId, token, signal).catch((error: unknown) => {
    // 只保留后端明确返回的受控结果；外层 HTTP 错误不能证明消费未执行。
    if (error instanceof ApiClientError && [
      "reset_stale", "reset_busy", "reset_unavailable", "reset_unknown",
      "management.confirmation-invalid", "management_audit_unavailable",
      "unauthorized", "invalid_request", "management_unavailable",
      "management.rate-limited", "management.origin-invalid",
      "management.request-line-too-large", "management.headers-too-large",
      "management.content-type-invalid", "management.body-too-large",
    ].includes(error.code)) throw error
    throw new ApiClientError("reset_unknown", 503, "reset_unknown")
  })

export function useResetCredits({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const management = useManagementConfirmedMutation({ load: fetchResetCredits, preview: previewResetCredit, apply: applyReset })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [selected, setSelected] = useState("")
  const [result, setResult] = useState<ResetCreditResult | null>(null)
  const operation = useRef<AbortController | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelFailed, setCancelFailed] = useState(false)
  useEffect(() => () => { operation.current?.abort() }, [])
  const busy = management.busy || refreshing || cancelling
  const pending = management.pendingPreview
  const credit = pending?.preview.credit ?? management.data?.credits.find(item => item.id === selected)
  const selectCredit = (value: string) => { setSelected(value); setResult(null) }
  const preview = async () => {
    if (busy || operation.current || management.loading || management.error !== null || !credit || pending) return
    const active = new AbortController()
    operation.current = active
    setResult(null)
    setCancelFailed(false)
    try { await management.mutate({ creditId: selected }) }
    finally { if (operation.current === active) operation.current = null }
  }
  const confirm = async () => {
    if (busy || operation.current) return
    const active = new AbortController()
    operation.current = active
    try {
      const outcome = await management.confirm()
      if (!active.signal.aborted && outcome) { setResult(outcome); onChanged(); setSelected("") }
    } finally { if (operation.current === active) operation.current = null }
  }
  const refresh = async () => {
    if (busy || operation.current || management.loading || pending) return
    const active = new AbortController()
    operation.current = active
    management.clearError()
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      await refreshOfficialAccountSnapshot("openai", active.signal)
      if (!active.signal.aborted) onChanged()
    } catch {
      if (!active.signal.aborted) setRefreshFailed(true)
    } finally {
      if (operation.current === active) operation.current = null
      if (!active.signal.aborted) {
        management.refetch()
        setSelected("")
        setRefreshing(false)
      }
    }
  }
  const cancel = async (close: boolean) => {
    if (busy || operation.current) return
    if (!pending) { onClose(); return }
    const active = new AbortController()
    operation.current = active
    setCancelling(true)
    setCancelFailed(false)
    try {
      await cancelResetCredit(pending.preview.attemptId, pending.confirmationToken, AbortSignal.any([active.signal, AbortSignal.timeout(5_000)]))
      if (!active.signal.aborted && close) onClose()
    } catch {
      if (!active.signal.aborted) setCancelFailed(true)
    } finally {
      if (operation.current === active) operation.current = null
      if (!active.signal.aborted) { management.cancel(); setCancelling(false) }
    }
  }
  const errorCode = management.actionErrorCode
  const errorKey: MessageKey = errorCode === "reset_unknown" ? "resetCredits.unknown"
    : errorCode === "reset_stale" || errorCode === "management.confirmation-invalid" ? "resetCredits.stale"
    : errorCode === "reset_busy" ? "resetCredits.busy" : "resetCredits.unavailable"
  return { management, busy, pending, credit, selected, selectCredit, result, refreshFailed, cancelFailed, errorKey, preview, confirm, refresh, cancel }
}
