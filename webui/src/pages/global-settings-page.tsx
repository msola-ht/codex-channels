import { useCallback, useEffect, useRef, useState } from "react"
import { useBeforeUnload, useBlocker, useSearchParams } from "react-router"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useTranslation } from "@/hooks/use-translation"
import { globalSettingsSection, globalSettingsSections, type GlobalSettingsSection } from "@/lib/navigation"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { SettingsPageFrame } from "@/components/settings/settings-page-frame"
import { SettingsError } from "@/components/settings/settings-feedback"
import { SettingsMutationFeedback, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"

export function GlobalSettingsPage() {
  const { t } = useTranslation()
  const management = useCodexSettingsManagement()
  const [params, setParams] = useSearchParams()
  const requested = params.get("section")
  const [editing, setEditing] = useState(false)
  const triggers = useRef<Partial<Record<GlobalSettingsSection, HTMLButtonElement | null>>>({})
  const section = globalSettingsSection(requested)
  const locked = management.saving || management.pendingSetting !== null
  const blocker = useBlocker(editing || locked)
  const busy = locked || management.loading || management.readbackRequired
  const changeSection = useCallback((target: string | null) => {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      if (target === null) next.delete("section")
      else next.set("section", target)
      return next
    })
  }, [setParams])

  useEffect(() => {
    if (blocker.state === "blocked" && locked) blocker.reset()
  }, [blocker, locked])
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (editing || locked) { event.preventDefault(); event.returnValue = "" }
  }, [editing, locked]))

  const settings = !management.loading && management.error === null && !management.readbackRequired ? management.codexSettings : null
  const summary = (id: GlobalSettingsSection) => {
    if (!settings) return t(management.loading ? "common.loading" : "settingsFields.unavailable")
    if (id === "models") return t("globalSettings.modelSummary", { model: settings.defaults.configuredModel ?? t("settingsFields.notSet"), effort: settings.defaults.reasoningEffort ?? t("managementUi.followModelDefault") })
    if (id === "context") return t("globalSettings.contextSummary", { window: settings.compact.contextWindow ?? t("managementUi.followModelDefault"), limit: settings.compact.autoCompactTokenLimit ?? t("settingsFields.compactDefault") })
    if (id === "general") return t("globalSettings.generalSummary", { search: settings.defaults.unsupportedFields.includes("webSearch") ? t("globalSettings.unsupportedValue") : settings.defaults.webSearch === null ? t("settingsFields.notSet") : t(settings.defaults.webSearch === "disabled" ? "settingsFields.off" : settings.defaults.webSearch === "live" ? "settingsFields.live" : settings.defaults.webSearch === "indexed" ? "settingsFields.indexed" : "settingsFields.cached") })
    if (id === "permissions") return t("globalSettings.permissionsSummary", { reviewer: settings.approvalsReviewer.reason === "unsupported-value" ? t("globalSettings.unsupportedValue") : settings.approvalsReviewer.value === "user" ? t("settingsFields.manualReview") : settings.approvalsReviewer.value === "auto_review" ? t("settingsFields.autoReview") : t("settingsFields.notSet") })
    return t("globalSettings.toolsSummary", { count: settings.toolSettings.fields.length })
  }

  return <SettingsPageFrame title="globalSettings.title" busy={locked || management.loading || section !== null || editing} refresh={management.refetch}>
    <Alert><AlertDescription>{t("globalSettings.scopeHint")}</AlertDescription></Alert>
    {requested !== null && section === null && <Alert variant="destructive"><AlertDescription className="flex flex-col items-start gap-2">{t("globalSettings.invalidSection")}<Button variant="outline" onClick={() => changeSection(null)}>{t("globalSettings.showGroups")}</Button></AlertDescription></Alert>}
    {management.error !== null && <SettingsError title={t("settingsUi.codexLoadFailed")} message={management.error} retry={management.refetch} />}
    <SettingsMutationFeedback result={management.actionResult} writeUnconfirmed={management.writeUnconfirmed} readbackRequired={management.readbackRequired} />
    <div className="flex flex-col gap-4">
      {globalSettingsSections.map(group => <Card key={group.id}>
        <CardHeader><CardTitle>{t(group.labelKey)}</CardTitle><CardDescription>{t(group.descriptionKey)}</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 break-words text-sm text-muted-foreground">{summary(group.id)}</p>
          <Button ref={element => { triggers.current[group.id] = element }} variant="outline" disabled={busy || section !== null || settings === null} aria-label={t("globalSettings.editGroup", { group: t(group.labelKey) })} onClick={() => changeSection(group.id)}>{t("modelManagement.actions")}</Button>
        </CardContent>
      </Card>)}
    </div>
    <Alert><AlertDescription>{t("globalSettings.cliHint")}</AlertDescription></Alert>
    {section && <Dialog open onOpenChange={open => { if (!open && !locked) changeSection(null) }}>
      <DialogContent finalFocus={() => triggers.current[section.id] ?? null} closeLabel={t("common.close")} showCloseButton={!locked} className={modelOperationDialogClassName}>
        <DialogHeader><DialogTitle>{t(section.labelKey)}</DialogTitle><DialogDescription>{t(section.descriptionKey)}</DialogDescription></DialogHeader>
        <AppServerSettingsCard key={section.id} management={management} section={section.id} onEditingChange={setEditing} renderContent={content => content} />
        <DialogFooter>
          {management.readbackRequired && <Button variant="outline" disabled={locked || management.loading} onClick={management.refetch}>{t("relay.refresh")}</Button>}
          <Button variant="outline" disabled={locked} onClick={() => changeSection(null)}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
    <AlertDialog open={blocker.state === "blocked" && !locked} onOpenChange={open => { if (!open && blocker.state === "blocked") blocker.reset() }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t("globalSettings.discardTitle")}</AlertDialogTitle><AlertDialogDescription>{t("globalSettings.discardHint")}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => { if (blocker.state === "blocked") blocker.reset() }}>{t("globalSettings.keepEditing")}</Button>
          <Button variant="destructive" onClick={() => { if (blocker.state === "blocked") blocker.proceed() }}>{t("globalSettings.discardDraft")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsPageFrame>
}
