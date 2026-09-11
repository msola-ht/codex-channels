import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ManagedInputRow, ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"

export function WebuiDataSettingsCard({ management }: { management: GatewaySettingsController }) {
  const settings = management.managedSettings
  const [webuiToken, setWebuiToken] = useState("")
  const tokenPreviewOpen = management.pendingSetting?.kind === "webui.token"
  const tokenPreviewStarted = useRef(false)
  useEffect(() => {
    if (tokenPreviewStarted.current && !management.saving && !tokenPreviewOpen) {
      setWebuiToken("")
      tokenPreviewStarted.current = false
    }
  }, [management.saving, tokenPreviewOpen])
  if (settings === null) return null
  const disabled = management.saving || management.pendingSetting !== null
  return <Card>
      <CardHeader><CardTitle>WebUI 与指标存储设置</CardTitle><CardDescription>管理本地 WebUI 和指标保留策略。</CardDescription></CardHeader>
      <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        <ManagedSelect label="指标保留" value={String(settings.metrics.storage.retentionDays)} options={[["30", "30 天"], ["90", "90 天"], ["365", "365 天"], ["730", "730 天"]]} disabled={disabled} onChange={(value) => void management.previewSetting("metrics.storage", { retentionDays: Number(value), maxRows: settings.metrics.storage.maxRows }, "指标保留")} />
        <ManagedSelect label="WebUI 端口" value={String(settings.webui.port)} options={[["8787", "8787"], ["8790", "8790"], ["8800", "8800"]]} disabled={disabled} onChange={(value) => void management.previewSetting("webui.port", Number(value), "WebUI 端口")} />
        <ManagedSelect label="WebUI 监听地址" value={settings.webui.host} options={[["127.0.0.1", "127.0.0.1"], ["::1", "::1"], ["0.0.0.0", "0.0.0.0"]]} disabled={disabled} onChange={(value) => void management.previewSetting("webui.host", value, "WebUI 监听地址")} />
        <ManagedInputRow label="WebUI 访问令牌" type="password" defaultValue="" value={webuiToken} onChange={setWebuiToken} placeholder={settings.webui.tokenConfigured ? "留空保持不变" : "输入新令牌"} disabled={disabled} onBlur={(value) => { if (value !== "") { tokenPreviewStarted.current = true; void management.previewSetting("webui.token", { action: "set", value }, "WebUI 访问令牌") } }} />
        <SettingsRow label="WebUI 令牌" value={configuredLabel(settings.webui.tokenConfigured)} />
        <SettingsRow label="显式代理" value={settings.network.configuredFields.join("、") || "未配置"} />
      </CardContent>
    </Card>
}

function configuredLabel(value: boolean): string { return value ? "已配置" : "未配置" }
