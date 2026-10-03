import { Trash2Icon } from "lucide-react"
import { useManagementTaskRefresh } from "@/hooks/use-management-tasks"

import { ManagementTaskConfirmationDialog } from "@/components/settings/management-task-controls"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useTranslation } from "@/hooks/use-translation"
import type { ManagementTaskController } from "@/lib/settings-management"
import type { Translate } from "@/lib/i18n/messages"

export function TrafficCleanupControls({ tasks, onCompleted }: {
  tasks: ManagementTaskController
  onCompleted: () => void
}) {
  const { t } = useTranslation()
  const latest = tasks.tasks.findLast((task) => task.operation === "traffic")
  const active = tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  const disabled = tasks.loading || tasks.error !== null || tasks.saving || tasks.pendingPreview !== null || active
  const error = tasks.actionError ?? tasks.error ?? latest?.error ?? null
  useManagementTaskRefresh(tasks, onCompleted)

  return <>
    <div className="flex items-center gap-2">
      {latest === undefined ? null : <Badge variant={latest.state === "completed" ? "secondary" : latest.state === "failed" ? "destructive" : "outline"}>
        {taskStateLabel(t, latest.state)}
      </Badge>}
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={disabled}
        onClick={() => void tasks.run({ operation: "traffic", action: "cleanup" })}
      >
        {tasks.saving ? <Spinner aria-label={t("common.loading")} data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
        {t("traffic.cleanupAction")}
      </Button>
    </div>
    {tasks.notificationError && <Alert><AlertDescription>{tasks.notificationError}<Button variant="outline" size="sm" disabled={tasks.loading} onClick={tasks.refetch}>{t("traffic.retryTasks")}</Button></AlertDescription></Alert>}
    {error === null ? null : <Alert variant="destructive">
      <AlertDescription>{t("errors.unknown")}{tasks.error !== null ? <Button variant="outline" size="sm" disabled={tasks.loading} onClick={tasks.refetch}>{t("traffic.retryTasks")}</Button> : null}</AlertDescription>
    </Alert>}
    <ManagementTaskConfirmationDialog tasks={tasks} />
  </>
}

function taskStateLabel(t: Translate, state: string): string {
  if (state === "completed") return t("traffic.taskCompleted")
  if (state === "failed") return t("traffic.taskFailed")
  if (state === "cancelled") return t("traffic.taskCancelled")
  if (state === "cancelling") return t("traffic.taskCancelling")
  return state === "queued" ? t("traffic.taskQueued") : t("traffic.taskRunning")
}
