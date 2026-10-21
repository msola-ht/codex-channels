import { Alert, AlertDescription } from "@/components/ui/alert"
import { useTranslation } from "@/hooks/use-translation"
import type { ManagementTask } from "@/lib/types"

export function ManagementTaskFeedback({ task }: { task: ManagementTask | undefined }) {
  const { t } = useTranslation()
  if (!task) return null
  const terminalProblem = task.state === "failed" || task.state === "cancelled"
  const code = task.errorCode
  const result = task.result
  const messages: string[] = []
  if (code) messages.push(t(`managementUi.taskErrors.${code}`))
  if (result?.commitState === "unknown") messages.push(t("managementUi.taskWriteUnknown"))
  else if (terminalProblem && result?.commitState === "committed") messages.push(t("managementUi.taskCommitted"))
  else if (terminalProblem && result?.commitState === "not_started") messages.push(t("managementUi.taskNotStarted"))
  else if (terminalProblem && result?.commitState === "not_committed") messages.push(t("managementUi.taskNotCommitted"))
  else if (terminalProblem && messages.length === 0) messages.push(t("managementUi.taskCheckState"))
  for (const phase of result?.failurePhases ?? []) {
    const key = phase === "lock-release" ? "lockRelease" : phase === "gateway-restart" ? "gatewayRestart" : phase
    messages.push(t(`managementUi.taskPhases.${key}`))
  }
  if (messages.length === 0) return null
  return <Alert variant={task.state === "failed" ? "destructive" : "default"}>
    <AlertDescription>{messages.join(" ")}</AlertDescription>
  </Alert>
}
