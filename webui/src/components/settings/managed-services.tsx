import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { ManagementTaskController } from "@/lib/settings-management"
import type { ManagementServicesResponse } from "@/lib/types"

export function ManagedServices({ services, tasks }: { services: ManagementServicesResponse; tasks: ManagementTaskController }) {
  if (services.entries.length === 0) {
    return <span className="text-sm text-muted-foreground">当前平台没有可展示的受管服务。</span>
  }
  const taskBusy = tasks.loading || tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  return <>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={taskBusy || services.platform === null} onClick={() => void tasks.run({ operation: "service", action: "install" })}>安装全部服务</Button>
      <Button variant="outline" size="sm" disabled={taskBusy || services.platform === null} onClick={() => void tasks.run({ operation: "service", action: "uninstall" })}>卸载全部服务</Button>
    </div>
    {services.entries.map((service, index) => (
      <div key={service.target}>
        {index > 0 ? <Separator /> : null}
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{service.name}</span>
              <span className="text-xs text-muted-foreground">
                {service.state}
                {service.version === null ? " · 版本未知" : ` · ${service.version}`}
                {service.pid === null ? "" : ` · PID ${service.pid}`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={service.running ? "secondary" : "destructive"}>{serviceStatusLabel(service)}</Badge>
              <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: service.running ? "restart" : "start", target: service.target })}>{service.running ? "重启" : "启动"}</Button>
              {service.target === "gateway" ? <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: "reload" })}>重载</Button> : null}
              {service.running ? <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: "stop", target: service.target })}>停止</Button> : null}
            </div>
          </div>
          {service.recentError !== null ? <p className="text-xs text-destructive">最近错误：{service.recentError.message}</p> : null}
        </div>
      </div>
    ))}
    {services.platform === null ? <p className="text-xs text-muted-foreground">当前平台服务状态不可用，请使用 CLI 查看详细信息。</p> : null}
    {tasks.error !== null ? <p className="mt-2 text-xs text-destructive" role="status">任务状态读取失败：{tasks.error}</p> : null}
    {tasks.tasks.length > 0 ? <RecentManagementTasks tasks={tasks} /> : null}
  </>
}

function RecentManagementTasks({ tasks }: { tasks: ManagementTaskController }) {
  return <div className="mt-2 rounded-md border p-2 text-xs">
    <span className="font-medium">最近管理任务</span>
    {tasks.tasks.slice(-3).map((task) => <div key={task.id} className="mt-1 flex items-center justify-between gap-2"><span>{task.operation}:{task.action}{task.target ? `:${task.target}` : ""}</span><div className="flex items-center gap-2"><Badge variant={task.state === "completed" ? "secondary" : task.state === "failed" ? "destructive" : "outline"}>{task.state}</Badge>{["queued", "running", "cancelling"].includes(task.state) ? <Button variant="ghost" size="sm" disabled={tasks.loading || task.state === "cancelling"} onClick={() => void tasks.cancel(task.id)}>取消</Button> : null}</div></div>)}
  </div>
}

function serviceStatusLabel(service: { loaded: boolean; running: boolean; state: string }): string {
  if (service.running) return "运行中"
  if (service.state === "unavailable") return "状态不可用"
  return service.loaded ? "已停止" : "未安装"
}
