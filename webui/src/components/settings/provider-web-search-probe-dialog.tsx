import { useState, type RefObject } from "react"
import { useProviderWebSearchProbe } from "@/hooks/use-provider-web-search-probe"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { translateCustomModelProbeReason } from "@/lib/custom-model-probe"
import { ManagedSelect, SettingsRow, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FieldGroup } from "@/components/ui/field"

export interface ProviderWebSearchProbeTarget {
  model: string
  displayName: string
  revision: string
  providers: string[]
}

export function ProviderWebSearchProbeDialog({ target, stale, disabled, finalFocus, onClose }: {
  target: ProviderWebSearchProbeTarget | null
  stale: boolean
  disabled: boolean
  finalFocus: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation()
  // Requiring a selection for shared catalogs prevents an implicit account choice.
  const [provider, setProvider] = useState(target?.providers.length === 1 ? target.providers[0]! : "")
  const valid = target !== null && target.providers.includes(provider)
  const input = target !== null && valid ? { provider, model: target.model, revision: target.revision } : null
  const probe = useProviderWebSearchProbe(input, target !== null && !stale && !disabled && valid)
  const close = () => { probe.invalidate(); onClose() }
  const check = probe.state?.result?.check
  return <Dialog open={target !== null} onOpenChange={open => { if (!open) close() }}>
    <DialogContent finalFocus={finalFocus} closeLabel={t("common.close")} className={modelOperationDialogClassName}>
      <DialogHeader><DialogTitle>{t("modelProbe.detectWebSearch")}</DialogTitle><DialogDescription>{t("modelProbe.configuredTargetHint")}</DialogDescription></DialogHeader>
      <div className="flex flex-col gap-4">
        {target && <SettingsRow label={t("modelManagement.model")} value={`${target.displayName} (${target.model})`} />}
        <FieldGroup><ManagedSelect fullWidth label={t("modelProbe.targetAccount")} value={provider} placeholder={t("modelProbe.selectAccount")} options={target?.providers.map(id => [id, id]) ?? []} disabled={stale || disabled || probe.running} onChange={value => { probe.invalidate(); setProvider(value) }} /></FieldGroup>
        {stale && <Alert variant="destructive"><AlertDescription>{t("modelProbe.targetStale")}</AlertDescription></Alert>}
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {probe.running && <p>{t("modelProbe.running")}</p>}
          {probe.state?.errorCode && <Alert variant="destructive"><AlertDescription>{translateApiErrorCode(t, probe.state.errorCode)}</AlertDescription></Alert>}
          {(probe.state?.cancelled || probe.state?.result?.status === "cancelled") && <p>{t("modelProbe.cancelled")}</p>}
          {check && <><Badge variant={check.status === "supported" ? "secondary" : "outline"}>{t(`modelProbe.statuses.${check.status}`)}</Badge><p>{translateCustomModelProbeReason(t, check.reason)}</p><p>{check.httpStatus === undefined ? t("modelProbe.noHttpStatus") : t("modelProbe.httpStatus", { status: check.httpStatus })}</p><p className="text-sm text-muted-foreground">{t("modelProbe.webSearchResultHint")}</p></>}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t("modelProbe.webSearchHint")}</p>
      <DialogFooter><Button variant="outline" onClick={close}>{t("common.close")}</Button>{probe.running ? <Button variant="outline" onClick={probe.cancel}>{t("modelProbe.cancel")}</Button> : <Button disabled={!valid || stale || disabled} onClick={() => void probe.start()}>{t("modelProbe.startWebSearch")}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>
}
