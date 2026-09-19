import { Trash2Icon } from "lucide-react"
import { useEffect, useRef } from "react"

import { ManagementTaskConfirmationDialog } from "@/components/settings/management-task-controls"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { ManagementTaskController } from "@/lib/settings-management"

export function TrafficCleanupControls({ tasks, onCompleted }: {
  tasks: ManagementTaskController
  onCompleted: () => void
}) {
  const latest = tasks.tasks.findLast((task) => task.operation === "traffic")
  const refreshedTaskId = useRef<string | null>(null)
  const active = tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  const disabled = tasks.loading || tasks.saving || tasks.pendingPreview !== null || active
  const error = tasks.actionError ?? latest?.error ?? null
  useEffect(() => {
    if (latest?.state !== "completed" || refreshedTaskId.current === latest.id) return
    refreshedTaskId.current = latest.id
    onCompleted()
  }, [latest, onCompleted])

  return <>
    <div className="flex items-center gap-2">
      {latest === undefined ? null : <Badge variant={latest.state === "completed" ? "secondary" : latest.state === "failed" ? "destructive" : "outline"}>
        {taskStateLabel(latest.state)}
      </Badge>}
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={disabled}
        onClick={() => void tasks.run({ operation: "traffic", action: "cleanup" })}
      >
        {tasks.saving ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
        清空调用记录
      </Button>
    </div>
    {error === null ? null : <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>}
    <ManagementTaskConfirmationDialog tasks={tasks} />
  </>
}

function taskStateLabel(state: string): string {
  if (state === "completed") return "清理完成"
  if (state === "failed") return "清理失败"
  if (state === "cancelled") return "已取消"
  if (state === "cancelling") return "取消中"
  return state === "queued" ? "等待清理" : "清理中"
}
