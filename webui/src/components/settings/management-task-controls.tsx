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
  ["cleanup", "清理指标库"],
  ["reset", "重建指标库"],
] as const

export function ManagementTaskControls({ tasks, providerIds = [], section = "data" }: { tasks: ManagementTaskController; providerIds?: string[]; section?: "data" | "services" }) {
  const { t } = useTranslation()
  const providerOptions = [...new Set(providerIds.filter((providerId) => providerId.length > 0))]
  const [editedPruneProvider, setPruneProvider] = useState<string | null>(null)
  const pruneProvider = editedPruneProvider ?? providerOptions[0] ?? ""
  const hasActiveTask = tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  const disabled = tasks.loading || tasks.error !== null || tasks.saving || tasks.pendingPreview !== null || hasActiveTask

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(section === "data" ? "navigation.data" : "navigation.services")}</CardTitle>
        <CardDescription>{t(section === "data" ? "navigation.dataHint" : "navigation.servicesHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {section === "services" && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void tasks.run({ operation: "update" })}>更新源码</Button>}
          {section === "data" && maintenanceActions.map(([action, label]) => (
            <Button key={action} variant="destructive" size="sm" disabled={disabled} onClick={() => void tasks.run({ operation: "metrics", action })}>{label}</Button>
          ))}
        </div>
        {section === "data" && <FieldGroup className="gap-0">
          <Field orientation="responsive" data-disabled={disabled}>
            <FieldLabel htmlFor="management-prune-provider" className="text-muted-foreground">清理 Provider 指标</FieldLabel>
            <FieldContent className="flex-row items-center gap-2">
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
                variant="destructive"
                size="sm"
                disabled={disabled || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(pruneProvider)}
                onClick={() => void tasks.run({ operation: "metrics", action: "prune", target: pruneProvider })}
              >清理
              </Button>
            </FieldContent>
          </Field>
        </FieldGroup>}
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
  // 仅翻译清理预览的受控文案；未知预览原样保留，避免丢失确认所需信息。
  const previewText = (value: string) => {
    if (!isTraffic) return value
    if (value === "执行 codexc traffic cleanup --confirm") return t("traffic.cleanupEffect", { command: "codexc traffic cleanup --confirm" })
    if (value === "全部 App Server 与 Relay 必须已停止") return t("traffic.cleanupStoppedRequired")
    if (value === "永久删除全部可识别调用记录，无法恢复；未知文件与目录不处理") return t("traffic.cleanupIrreversible")
    return value
  }
  const description = [
    isTraffic ? t("traffic.cleanupOperation", { operation: pending.preview.operation, action: pending.preview.action }) : `操作：${pending.preview.operation} · ${pending.preview.action}`,
    pending.preview.target ? (isTraffic ? t("traffic.cleanupTarget", { target: pending.preview.target }) : `目标：${pending.preview.target}`) : null,
    ...pending.preview.effects.map(previewText),
    ...pending.preview.preconditions.map((condition) => isTraffic ? t("traffic.cleanupPrecondition", { condition: previewText(condition) }) : `前置条件：${condition}`),
    pending.preview.recovery ? (isTraffic ? t("traffic.cleanupRecovery", { recovery: previewText(pending.preview.recovery) }) : `失败处理：${pending.preview.recovery}`) : null,
  ].filter((item): item is string => item !== null)
  const destructive = pending.input.operation === "metrics"
    || pending.input.operation === "traffic"
    || (pending.input.operation === "service" && (pending.input.action === "uninstall" || pending.input.action === "stop"))
  const traffic = pending.input.operation === "traffic"
    ? trafficCleanupResource(pending.preview.resource)
    : null
  return <ManagementConfirmationDialog open saving={tasks.saving} loading={tasks.loading} title={isTraffic ? t("traffic.cleanupConfirmTitle") : "确认执行管理任务"} description={isTraffic ? t("traffic.cleanupConfirmDescription") : "确认后提交后台任务，任务将在服务端串行执行。"} confirmLabel={isTraffic ? t("traffic.cleanupConfirmAction") : "确认执行"} confirmVariant={destructive ? "destructive" : "default"} confirmDisabled={traffic?.writersRunning === true} onConfirm={() => void tasks.confirm()} onCancel={tasks.cancelPending}>
    <p className="whitespace-pre-line">{description.join("\n") || pending.input.operation}</p>
    {traffic === null ? null : <p className="mt-2 text-muted-foreground">
      {t(traffic.writersRunning ? "traffic.cleanupResourceRunning" : "traffic.cleanupResourceStopped", {
        sessions: traffic.v2Sessions, files: traffic.legacyFiles, size: formatBytes(traffic.bytes),
      })}
    </p>}
  </ManagementConfirmationDialog>
}

function trafficCleanupResource(value: unknown): {
  writersRunning: boolean
  bytes: number
  legacyFiles: number
  v2Sessions: number
} | null {
  if (value === null || typeof value !== "object" || !("dumps" in value)) return null
  const dumps = value.dumps
  if (dumps === null || typeof dumps !== "object") return null
  const bytes = "bytes" in dumps ? dumps.bytes : undefined
  const legacyFiles = "legacyFiles" in dumps ? dumps.legacyFiles : undefined
  const v2Sessions = "v2Sessions" in dumps ? dumps.v2Sessions : undefined
  if (typeof bytes !== "number" || typeof legacyFiles !== "number" || typeof v2Sessions !== "number") return null
  const appServer = "appServer" in value ? value.appServer : null
  const relay = "modelRelay" in value ? value.modelRelay : null
  return {
    writersRunning: [appServer, relay].some(service => service !== null && typeof service === "object" && "running" in service && service.running === true),
    bytes,
    legacyFiles,
    v2Sessions,
  }
}
