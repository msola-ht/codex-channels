import { useState } from "react"
import { useTranslation } from "@/hooks/use-translation"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { formatBytes } from "@/lib/format"
import type { ManagementTaskController } from "@/lib/settings-management"

const maintenanceActions = [
  ["cleanup", "managementUi.metricsCleanup"],
  ["reset", "managementUi.metricsReset"],
] as const

export function ManagementTaskControls({ tasks, providerIds = [] }: { tasks: ManagementTaskController; providerIds?: string[] }) {
  const { t } = useTranslation()
  const providerOptions = [...new Set(providerIds.filter((providerId) => providerId.length > 0))]
  const [editedPruneProvider, setPruneProvider] = useState<string | null>(null)
  const pruneProvider = editedPruneProvider ?? providerOptions[0] ?? ""
  const hasActiveTask = tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  const disabled = tasks.loading || tasks.error !== null || tasks.saving || tasks.pendingPreview !== null || hasActiveTask

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("navigation.data")}</CardTitle>
        <CardDescription>{t("navigation.dataHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {maintenanceActions.map(([action, label]) => (
            <Button key={action} variant="destructive" size="sm" disabled={disabled} onClick={() => void tasks.run({ operation: "metrics", action })}>{t(label)}</Button>
          ))}
        </div>
        <FieldGroup className="gap-0">
          <Field orientation="responsive" data-disabled={disabled}>
            <FieldLabel htmlFor="management-prune-provider" className="text-muted-foreground">{t("managementUi.pruneProvider")}</FieldLabel>
            <FieldContent className="flex-row items-center gap-2">
              <Input
                id="management-prune-provider"
                className="w-[180px]"
                list="management-prune-provider-options"
                value={pruneProvider}
                onChange={(event) => setPruneProvider(event.target.value)}
                placeholder={t("managementUi.providerExample")}
                disabled={disabled}
              />
              <datalist id="management-prune-provider-options">
                {providerOptions.map((providerId) => <option key={providerId} value={providerId} />)}
              </datalist>
              <Button
                variant="destructive"
                size="sm"
                disabled={disabled || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(pruneProvider)}
                onClick={() => void tasks.run({ operation: "metrics", action: "prune", target: pruneProvider })}
              >{t("managementUi.cleanup")}
              </Button>
            </FieldContent>
          </Field>
        </FieldGroup>
      </CardContent>
      <ManagementTaskConfirmationDialog tasks={tasks} />
    </Card>
  )
}

export function ManagementTaskConfirmationDialog({ tasks }: { tasks: ManagementTaskController }) {
  const { t } = useTranslation()
  const pending = tasks.pendingPreview
  if (pending === null) return null
  const isTraffic = pending.input.operation === "traffic"
  // 翻译已知受控预览文案；未知内容保留原值，避免丢失确认信息。
  const previewText = (value: string) => {
    if (value === "执行 codexc traffic cleanup --confirm") return t("traffic.cleanupEffect", { command: "codexc traffic cleanup --confirm" })
    if (value.startsWith("执行 codexc ")) return t("managementUi.executeCommand", { command: value.slice(3) })
    const known = {
      "Gateway 必须已停止，且指标 Socket 不可用": "managementUi.metricsStoppedRequired",
      "操作前备份本地指标库；失败时保留备份并尝试恢复原服务状态": "managementUi.pruneRecovery",
      "操作前保留指标数据库备份；失败时保留备份并重试": "managementUi.metricsRecovery",
      "服务管理器失败时任务标记失败，不自动扩大操作范围": "managementUi.serviceRecovery",
    } as const
    if (Object.hasOwn(known, value)) return t(known[value as keyof typeof known])
    if (value === "全部 App Server 与 Relay 必须已停止") return t("traffic.cleanupStoppedRequired")
    if (value === "永久删除全部可识别调用记录，无法恢复；未知文件与目录不处理") return t("traffic.cleanupIrreversible")
    return value
  }
  const description = [
    t("managementUi.operationAction", { operation: pending.preview.operation, action: pending.preview.action }),
    pending.preview.target ? t("managementUi.target", { target: pending.preview.target }) : null,
    ...pending.preview.effects.map(previewText),
    ...pending.preview.preconditions.map((condition) => t("managementUi.precondition", { condition: previewText(condition) })),
    pending.preview.recovery ? t("managementUi.recovery", { recovery: previewText(pending.preview.recovery) }) : null,
  ].filter((item): item is string => item !== null)
  const destructive = pending.input.operation === "metrics"
    || pending.input.operation === "traffic"
    || (pending.input.operation === "service" && (pending.input.action === "uninstall" || pending.input.action === "stop"))
  const traffic = pending.input.operation === "traffic"
    ? trafficCleanupResource(pending.preview.resource)
    : null
  return <ManagementConfirmationDialog open saving={tasks.saving} loading={tasks.loading} title={isTraffic ? t("traffic.cleanupConfirmTitle") : t("managementUi.taskConfirmTitle")} description={isTraffic ? t("traffic.cleanupConfirmDescription") : t("managementUi.taskConfirmDescription")} confirmLabel={isTraffic ? t("traffic.cleanupConfirmAction") : t("managementUi.confirmExecute")} confirmVariant={destructive ? "destructive" : "default"} confirmDisabled={traffic?.writersRunning === true} onConfirm={() => void tasks.confirm()} onCancel={tasks.cancelPending}>
    <p className="whitespace-pre-line">{description.join("\n") || pending.input.operation}</p>
    {traffic === null ? null : <p className="mt-2 text-muted-foreground">
      {t(traffic.writersRunning ? "traffic.cleanupResourceRunning" : "traffic.cleanupResourceStopped", {
        sessions: traffic.v2Sessions, size: formatBytes(traffic.bytes),
      })}
    </p>}
  </ManagementConfirmationDialog>
}

function trafficCleanupResource(value: unknown): {
  writersRunning: boolean
  bytes: number
  v2Sessions: number
} | null {
  if (value === null || typeof value !== "object" || !("dumps" in value)) return null
  const dumps = value.dumps
  if (dumps === null || typeof dumps !== "object") return null
  const bytes = "bytes" in dumps ? dumps.bytes : undefined
  const v2Sessions = "v2Sessions" in dumps ? dumps.v2Sessions : undefined
  if (typeof bytes !== "number" || typeof v2Sessions !== "number") return null
  const appServer = "appServer" in value ? value.appServer : null
  const relay = "modelRelay" in value ? value.modelRelay : null
  return {
    writersRunning: [appServer, relay].some(service => service !== null && typeof service === "object" && "running" in service && service.running === true),
    bytes,
    v2Sessions,
  }
}
