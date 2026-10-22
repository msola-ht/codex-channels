import { useCallback, useEffect } from "react"
import { useBeforeUnload, useBlocker } from "react-router"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"

/** One guard per settings page; reads never lock navigation or count as drafts. */
export function SettingsNavigationGuard({ editing, locked }: { editing: boolean; locked: boolean }) {
  const { t } = useTranslation()
  const blocker = useBlocker(editing || locked)
  useEffect(() => {
    if (blocker.state === "blocked" && locked) blocker.reset()
  }, [blocker, locked])
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (editing || locked) { event.preventDefault(); event.returnValue = "" }
  }, [editing, locked]))
  return <AlertDialog open={blocker.state === "blocked" && !locked} onOpenChange={open => { if (!open && blocker.state === "blocked") blocker.reset() }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t("globalSettings.discardTitle")}</AlertDialogTitle><AlertDialogDescription>{t("globalSettings.discardHint")}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter>
        <Button variant="outline" onClick={() => { if (blocker.state === "blocked") blocker.reset() }}>{t("globalSettings.keepEditing")}</Button>
        <Button variant="destructive" onClick={() => { if (blocker.state === "blocked") blocker.proceed() }}>{t("globalSettings.discardDraft")}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
