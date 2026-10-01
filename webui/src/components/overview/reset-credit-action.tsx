import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { useTranslation } from "@/hooks/use-translation"
import { ApiClientError, cancelResetCredit, consumeResetCredit, fetchResetCredits, previewResetCredit, refreshOfficialAccountSnapshot } from "@/lib/api"
import { formatTime } from "@/lib/format"
import type { ResetCreditPreview, ResetCreditResult } from "@/lib/types"

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

export function ResetCreditAction({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t("resetCredits.open")}</Button>
    {open ? <ResetCreditDialog onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
  </>
}

function ResetCreditDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation()
  const management = useManagementConfirmedMutation({ load: fetchResetCredits, preview: previewResetCredit, apply: applyReset })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [selected, setSelected] = useState("")
  const [result, setResult] = useState<ResetCreditResult | null>(null)
  const actionInFlight = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelFailed, setCancelFailed] = useState(false)
  const busy = management.busy || refreshing || cancelling
  const pending = management.pendingPreview
  const credit = pending?.preview.credit ?? management.data?.credits.find(item => item.id === selected)
  const confirm = async () => {
    if (busy || actionInFlight.current) return
    actionInFlight.current = true
    try {
      const outcome = await management.confirm()
      if (outcome) { setResult(outcome); onChanged(); setSelected("") }
    } finally { actionInFlight.current = false }
  }
  const refresh = async () => {
    management.clearError()
    setRefreshing(true)
    setRefreshFailed(false)
    try { await refreshOfficialAccountSnapshot("openai"); onChanged() }
    catch { setRefreshFailed(true) }
    finally { management.refetch(); setSelected(""); setRefreshing(false) }
  }
  const cancel = async (close: boolean) => {
    if (busy || actionInFlight.current) return
    if (!pending) { onClose(); return }
    actionInFlight.current = true
    setCancelling(true)
    setCancelFailed(false)
    try {
      await cancelResetCredit(pending.preview.attemptId, pending.confirmationToken, AbortSignal.timeout(5_000))
      if (close) onClose()
    } catch { setCancelFailed(true) }
    finally { management.cancel(); actionInFlight.current = false; setCancelling(false) }
  }
  const errorCode = management.actionErrorCode
  const errorMessage = errorCode === "reset_unknown" ? t("resetCredits.unknown")
    : errorCode === "reset_stale" || errorCode === "management.confirmation-invalid" ? t("resetCredits.stale")
    : errorCode === "reset_busy" ? t("resetCredits.busy") : t("resetCredits.unavailable")
  return <Dialog open onOpenChange={open => { if (!open && !busy) void cancel(true) }}>
    <DialogContent closeLabel={t("resetCredits.close")} showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>{pending ? t("resetCredits.confirmTitle") : t("resetCredits.open")}</DialogTitle>
        <DialogDescription>{t("resetCredits.description")}</DialogDescription>
      </DialogHeader>
      {management.loading ? <Spinner aria-label={t("common.loading")} /> : null}
      {management.error || management.actionError || cancelFailed ? <Alert variant="destructive"><AlertDescription>{cancelFailed ? t("resetCredits.unavailable") : errorMessage}</AlertDescription></Alert> : null}
      {refreshFailed ? <Alert variant="destructive"><AlertDescription>{t("resetCredits.manualRefreshFailed")}</AlertDescription></Alert> : null}
      {result ? <Alert><AlertDescription>
        <p>{t(`resetCredits.${result.outcome}`)}</p>
        {!result.refreshed ? <p>{t("resetCredits.refreshFailed")}</p> : null}
        {!result.auditRecorded ? <p>{t("resetCredits.auditFailed")}</p> : null}
      </AlertDescription></Alert> : null}
      {!pending && management.data ? <Field>
        <FieldLabel htmlFor="reset-credit-choice">{t("resetCredits.choose")}</FieldLabel>
        <Select value={selected} onValueChange={value => { setSelected(value); setResult(null) }} disabled={busy || management.loading}>
          <SelectTrigger id="reset-credit-choice" className="w-full"><SelectValue placeholder={t("resetCredits.choose")} /></SelectTrigger>
          <SelectContent><SelectGroup>{management.data.credits.map(item => <SelectItem key={item.id} value={item.id}>
            {item.title ?? t("resetCredits.defaultTitle")} · {item.expiresAt === null ? t("overview.creditNoExpiry") : formatTime(item.expiresAt * 1000)}
          </SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        {management.data.credits.length === 0 ? <p>{t("resetCredits.noChoices")}</p> : null}
      </Field> : null}
      {credit ? <div className="flex flex-col gap-2 text-sm">
        <p>{credit.title ?? t("resetCredits.defaultTitle")}</p>
        <p>{credit.description ?? t("resetCredits.description")}</p>
        <p>{credit.expiresAt === null ? t("overview.creditNoExpiry") : t("resetCredits.expires", { time: formatTime(credit.expiresAt * 1000) })}</p>
      </div> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => void cancel(false)}>{t("resetCredits.cancel")}</Button>
        {!pending ? <Button variant="outline" disabled={busy || management.loading} onClick={() => void refresh()}>{t("common.refresh")}</Button> : null}
        {pending ? <Button disabled={busy || management.loading || management.error !== null} onClick={() => void confirm()}>
          {management.busy ? <Spinner data-icon="inline-start" /> : null}{t("resetCredits.confirm")}
        </Button> : <Button disabled={busy || management.loading || !credit || management.error !== null}
          onClick={() => { setResult(null); setCancelFailed(false); void management.mutate({ creditId: selected }) }}>{t("resetCredits.preview")}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
