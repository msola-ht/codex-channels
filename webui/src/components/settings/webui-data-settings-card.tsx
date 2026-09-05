import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ManagedInputRow, ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"

export function WebuiDataSettingsCard({ management }: { management: GatewaySettingsController }) {
  const settings = management.managedSettings
  const [centerPortError, setCenterPortError] = useState<string | null>(null)
  if (settings === null) return null
  const disabled = management.saving || management.pendingSetting !== null
  const previewCenterPort = (raw: string) => {
    if (raw === "") {
      setCenterPortError(null)
      void management.previewSetting("metrics.center.port", null, "中心端口")
      return
    }
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      setCenterPortError("中心端口必须是 1–65535 的整数")
      return
    }
    setCenterPortError(null)
    void management.previewSetting("metrics.center.port", parsed, "中心端口")
  }
  return <Card>
      <CardHeader><CardTitle>WebUI 与数据中心设置</CardTitle><CardDescription>监听和指标同步参数可修改；凭据只显示是否已配置。</CardDescription></CardHeader>
      <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        <ManagedSelect label="指标保留" value={String(settings.metrics.storage.retentionDays)} options={[["30", "30 天"], ["90", "90 天"], ["365", "365 天"], ["730", "730 天"]]} disabled={disabled} onChange={(value) => void management.previewSetting("metrics.storage", { retentionDays: Number(value), maxRows: settings.metrics.storage.maxRows }, "指标保留")} />
        <ManagedSelect label="上报间隔" value={String(settings.metrics.sync.intervalSeconds)} options={[["30", "30 秒"], ["60", "60 秒"], ["300", "5 分钟"], ["900", "15 分钟"]]} disabled={disabled} onChange={(value) => void management.previewSetting("metrics.sync-params", { intervalSeconds: Number(value), batchSize: settings.metrics.sync.batchSize }, "上报间隔")} />
        <ManagedSelect label="批量大小" value={String(settings.metrics.sync.batchSize)} options={[["50", "50 条"], ["100", "100 条"], ["200", "200 条"], ["500", "500 条"]]} disabled={disabled} onChange={(value) => void management.previewSetting("metrics.sync-params", { intervalSeconds: settings.metrics.sync.intervalSeconds, batchSize: Number(value) }, "批量大小")} />
        <ManagedInputRow key={settings.revision} label="设备名称" defaultValue={settings.metrics.sync.deviceName ?? ""} placeholder="留空使用系统名称" disabled={disabled} onBlur={(value) => void management.previewSetting("metrics.sync-params", { deviceName: value === "" ? null : value }, "设备名称")} />
        <ManagedSelect label="WebUI 端口" value={String(settings.webui.port)} options={[["8787", "8787"], ["8790", "8790"], ["8800", "8800"]]} disabled={disabled} onChange={(value) => void management.previewSetting("webui.port", Number(value), "WebUI 端口")} />
        <ManagedSelect label="WebUI 监听地址" value={settings.webui.host} options={[["127.0.0.1", "127.0.0.1"], ["::1", "::1"], ["0.0.0.0", "0.0.0.0"]]} disabled={disabled} onChange={(value) => void management.previewSetting("webui.host", value, "WebUI 监听地址")} />
        <div key={settings.revision}><ManagedInputRow label="中心端口" type="number" defaultValue={String(settings.metrics.center.port)} placeholder="1–65535，留空恢复默认" disabled={disabled} onBlur={previewCenterPort} />{centerPortError !== null ? <p className="mt-1 text-right text-xs text-destructive" role="status">{centerPortError}</p> : null}</div>
        <ManagedInputRow label="WebUI 访问令牌" type="password" defaultValue="" placeholder={settings.webui.tokenConfigured ? "留空保持不变" : "输入新令牌"} disabled={disabled} onBlur={(value) => { if (value !== "") void management.previewSetting("webui.token", { action: "set", value }, "WebUI 访问令牌") }} />
        <SettingsRow label="WebUI 令牌" value={configuredLabel(settings.webui.tokenConfigured)} />
        <SettingsRow label="设备同步" value={enabledLabel(settings.metrics.sync.enabled)} />
        <SettingsRow label="设备上报令牌" value={configuredLabel(settings.metrics.sync.deviceTokenConfigured)} />
        <SettingsRow label="全局视图" value={enabledLabel(settings.metrics.view.enabled)} />
        <SettingsRow label="全局查看令牌" value={configuredLabel(settings.metrics.view.tokenConfigured)} />
        <SettingsRow label="数据中心" value={enabledLabel(settings.metrics.center.enabled)} />
        <SettingsRow label="中心地址" value={formatHostPort(settings.metrics.center.host, settings.metrics.center.port)} />
        <SettingsRow label="显式代理" value={settings.network.configuredFields.join("、") || "未配置"} />
      </CardContent>
    </Card>
}

function enabledLabel(value: boolean): string { return value ? "已启用" : "未启用" }
function configuredLabel(value: boolean): string { return value ? "已配置" : "未配置" }
function formatHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
}
