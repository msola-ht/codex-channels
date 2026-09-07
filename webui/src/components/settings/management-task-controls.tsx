import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import type { ManagementTaskController } from "@/lib/settings-management"

const maintenanceActions = [
  ["upgrade", "升级指标库"],
  ["sync-reset", "重置同步水位"],
  ["cleanup", "清理指标库"],
  ["reset", "重建指标库"],
] as const

export function ManagementTaskControls({ tasks, providerIds }: { tasks: ManagementTaskController; providerIds: string[] }) {
  const providerOptions = [...new Set(providerIds.filter((providerId) => providerId.length > 0))]
  const [pruneProvider, setPruneProvider] = useState(providerOptions[0] ?? "openai")
  const hasActiveTask = tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  const disabled = tasks.loading || tasks.saving || tasks.pendingPreview !== null || hasActiveTask

  return (
    <Card>
      <CardHeader>
        <CardTitle>维护任务</CardTitle>
        <CardDescription>通过当前 WebUI 令牌预览并确认服务、指标库和源码维护操作；任务在后台串行执行。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void tasks.run({ operation: "update" })}>更新源码</Button>
          {maintenanceActions.map(([action, label]) => (
            <Button key={action} variant="outline" size="sm" disabled={disabled} onClick={() => void tasks.run({ operation: "metrics", action })}>{label}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="management-prune-provider" className="text-muted-foreground">清理 Provider 指标</Label>
          <Input
            id="management-prune-provider"
            className="w-[180px]"
            list="management-prune-provider-options"
            value={pruneProvider}
            onChange={(event) => setPruneProvider(event.target.value)}
            placeholder="例如 openai"
            disabled={disabled}
          />
          <datalist id="management-prune-provider-options">
            {providerOptions.map((providerId) => <option key={providerId} value={providerId} />)}
          </datalist>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(pruneProvider)}
            onClick={() => void tasks.run({ operation: "metrics", action: "prune", target: pruneProvider })}
          >清理
          </Button>
        </div>
      </CardContent>
      <ManagementTaskConfirmationDialog tasks={tasks} />
    </Card>
  )
}

export function ManagementTaskConfirmationDialog({ tasks }: { tasks: ManagementTaskController }) {
  const pending = tasks.pendingPreview
  if (pending === null) return null
  const description = [
    `操作：${pending.preview.operation} · ${pending.preview.action}`,
    pending.preview.target ? `目标：${pending.preview.target}` : null,
    ...pending.preview.effects,
    ...pending.preview.preconditions.map((condition) => `前置条件：${condition}`),
    pending.preview.recovery ? `失败处理：${pending.preview.recovery}` : null,
  ].filter((item): item is string => item !== null)
  return <ManagementConfirmationDialog open saving={tasks.saving} title="确认执行管理任务" description="确认后提交后台任务，任务将在服务端串行执行。" confirmLabel="确认执行" onConfirm={() => void tasks.confirm()} onCancel={tasks.cancelPending}>
    <p className="whitespace-pre-line">{description.join("\n") || pending.input.operation}</p>
  </ManagementConfirmationDialog>
}
