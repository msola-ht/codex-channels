import { Link } from "react-router"
import { useTranslation } from "@/hooks/use-translation"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import type { ManagementTaskController } from "@/lib/settings-management"
import type { ManagementServicesResponse } from "@/lib/types"

export function ManagedServices({ services, tasks, scope, showTasks = true }: { services: ManagementServicesResponse; tasks: ManagementTaskController; showTasks?: boolean; scope?: ManagementServicesResponse["entries"][number]["target"] }) {
  const { t } = useTranslation()
  const otherTaskActive = scope && tasks.tasks.some(task => ["queued", "running", "cancelling"].includes(task.state) && (task.operation !== "service" || task.target !== scope))
  const entries = scope ? services.entries.filter(service => service.target === scope) : services.entries
  const recentTasks = scope ? tasks.tasks.filter(task => task.operation === "service" && task.target === scope) : tasks.tasks
  if (entries.length === 0) {
    return <SettingsEmpty>{t("managementUi.servicesEmpty")}</SettingsEmpty>
  }
  const taskBusy = tasks.loading || tasks.error !== null || tasks.saving || tasks.pendingPreview !== null || tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  return <>
    {otherTaskActive && <Alert><AlertDescription>{t("relay.otherTaskActive")} <Link to="/settings/services" className="underline">{t("relay.viewTasks")}</Link></AlertDescription></Alert>}
    {!scope && <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={taskBusy || services.platform === null} onClick={() => void tasks.run({ operation: "service", action: "install" })}>{t("managementUi.installAll")}</Button>
      <Button variant="destructive" size="sm" disabled={taskBusy || services.platform === null} onClick={() => void tasks.run({ operation: "service", action: "uninstall" })}>{t("managementUi.uninstallAll")}</Button>
    </div>}
    {entries.map((service, index) => (
      <div key={service.target}>
        {index > 0 ? <Separator /> : null}
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              {!scope && <span className="font-medium">{service.name}</span>}
              <span className="text-xs text-muted-foreground">
                {!scope && `${service.state === "unavailable" ? t("managementUi.statusUnavailable") : service.state === "missing" ? t("managementUi.notInstalled") : service.state} · `}
                {service.version === null ? t("managementUi.versionUnknown") : service.version}
                {service.pid === null ? "" : ` · PID ${service.pid}`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={service.running ? "secondary" : "destructive"}>{t(serviceStatusKey(service))}</Badge>
              {service.target !== "webui" || !service.running ? <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: service.running ? "restart" : "start", target: service.target })}>{t(service.running ? "managementUi.restart" : "managementUi.start")}</Button> : null}
              {service.target === "gateway" ? <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: "reload" })}>{t("managementUi.reload")}</Button> : null}
              {service.running ? <Button variant="destructive" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: "stop", target: service.target })}>{t("modelManagement.stop")}</Button> : null}
            </div>
          </div>
          {!service.running && service.recentError !== null ? <Alert variant="destructive"><AlertDescription>{t("managementUi.serviceRecentError")}</AlertDescription></Alert> : null}
          {service.target === "webui" && service.running ? <Alert><AlertDescription>{t("managementUi.webuiRestartTerminal", { command: "codexc restart webui" })}</AlertDescription></Alert> : null}
        </div>
      </div>
    ))}
    {services.platform === null ? <p className="text-xs text-muted-foreground">{t("managementUi.platformServiceUnavailable")}</p> : null}
    {showTasks && recentTasks.length > 0 ? <RecentManagementTasks tasks={{ ...tasks, tasks: recentTasks }} /> : null}
  </>
}

export function RecentManagementTasks({ tasks }: { tasks: ManagementTaskController }) {
  const { t } = useTranslation()
  return <div className="mt-2 rounded-md border p-2 text-xs">
    <span className="font-medium">{t("managementUi.recentTasks")}</span>
    {tasks.tasks.slice(-3).map((task) => <div key={task.id} className="mt-1 flex flex-wrap items-center justify-between gap-2"><span className="break-all">{task.operation}:{task.action}{task.target ? `:${task.target}` : ""}</span><div className="flex items-center gap-2"><Badge variant={task.state === "completed" ? "secondary" : task.state === "failed" ? "destructive" : "outline"}>{t(task.state === "queued" ? "managementUi.queued" : task.state === "running" ? "managementUi.running" : task.state === "cancelling" ? "managementUi.cancelling" : task.state === "completed" ? "delivery.contentStates.completed" : task.state === "failed" ? "delivery.contentStates.failed" : "managementUi.cancelled")}</Badge>{["queued", "running", "cancelling"].includes(task.state) ? <Button variant="ghost" size="sm" disabled={tasks.loading || task.state === "cancelling"} onClick={() => void tasks.cancel(task.id)}>{t("modelManagement.cancel")}</Button> : null}</div></div>)}
  </div>
}

function serviceStatusKey(service: { loaded: boolean; running: boolean; state: string }) {
  if (service.running) return "managementUi.running"
  if (service.state === "unavailable") return "managementUi.statusUnavailable"
  return service.loaded ? "managementUi.stopped" : "managementUi.notInstalled"
}
