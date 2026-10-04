import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useResetCredits } from "@/hooks/use-reset-credits"
import { useTranslation } from "@/hooks/use-translation"
import { formatTime } from "@/lib/format"

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
  const { management, busy, pending, credit, selected, selectCredit, result, refreshFailed, cancelFailed, errorKey, preview, confirm, refresh, cancel } = useResetCredits({ onClose, onChanged })
  const errorMessage = t(errorKey)
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
        <Select items={[{ value: null, label: t("resetCredits.choose") }, ...management.data.credits.map(item => ({ value: item.id, label: `${item.title ?? t("resetCredits.defaultTitle")} · ${item.expiresAt === null ? t("overview.creditNoExpiry") : formatTime(item.expiresAt * 1000)}` }))]} value={selected || null} onValueChange={value => { if (value !== null) { selectCredit(value) } }} disabled={busy || management.loading}>
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
          onClick={() => void preview()}>{t("resetCredits.preview")}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
