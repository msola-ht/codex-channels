import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ManagedInputRow, ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { SettingsResponse } from "@/lib/types"

export function GatewaySettingsCard({ management, currency, settings }: { management: GatewaySettingsController; currency: string | null; settings: SettingsResponse | null }) {
  const managedSettings = management.managedSettings
  if (managedSettings === null) return null
  const disabled = management.saving || management.pendingSetting !== null
  return <Card>
      <CardHeader><CardTitle>Gateway 设置</CardTitle><CardDescription>Gateway 渠道、系统、显示、自动化和运行日志；当前值与修改入口在同一分区。</CardDescription></CardHeader>
      <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        <ManagedSelect label="Sandbox" value={managedSettings.system.sandbox} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={disabled} onChange={(value) => void management.previewSetting("system.sandbox", value, "Sandbox")} />
        <ManagedSelect label="审批超时" value={String(managedSettings.system.approvalTimeoutSeconds)} options={[["300", "300 秒"], ["600", "600 秒"], ["900", "900 秒"], ["1800", "1800 秒"]]} disabled={disabled} onChange={(value) => void management.previewSetting("system.approval-timeout", Number(value), "审批超时")} />
        <ManagedInputRow key={managedSettings.revision} label="渠道新会话模型" defaultValue={managedSettings.system.defaultModel ?? ""} placeholder="留空跟随 Codex 全局默认" disabled={disabled} onBlur={(value) => void management.previewSetting("system.default-model", value === "" ? null : value, "渠道新会话模型")} />
        <ManagedSelect label="默认 Workspace" value={managedSettings.system.defaultWorkspace ?? ""} options={managedSettings.system.workspaces.map((workspace) => [workspace.id, workspace.name])} disabled={disabled || managedSettings.system.workspaces.length === 0} onChange={(value) => void management.previewSetting("system.default-workspace", value, "默认 Workspace")} />
        <ManagedSelect label="操作详情" value={managedSettings.display.operationUpdates} options={[["full", "完整"], ["compact", "紧凑"], ["hidden", "隐藏"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.operation-updates", value, "操作详情")} />
        <ManagedSelect label="计划更新" value={String(managedSettings.display.planUpdatesEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.plan-updates", value === "true", "计划更新")} />
        <ManagedSelect label="思考状态" value={String(managedSettings.display.reasoningEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.reasoning", value === "true", "思考状态")} />
        <ManagedSelect label="价格币种" value={managedSettings.display.priceCurrency} options={[["cny", "人民币"], ["usd", "美元"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.price-currency", value, "价格币种")} />
        <ManagedSelect label="计划任务" value={String(managedSettings.automation.scheduledTasksEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("automation.scheduled-tasks", value === "true", "计划任务")} />
        <ManagedSelect label="日志等级" value={managedSettings.advanced.loggingLevel} options={[["fatal", "fatal"], ["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"], ["trace", "trace"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.logging-level", value, "日志等级")} />
        <SettingsRow label="当前页面货币" value={(currency ?? managedSettings.display.priceCurrency).toUpperCase()} badge />
        <SettingsRow label="美元兑人民币" value={settings?.exchangeRate?.usdToCny.toString() ?? "暂无"} />
        <SettingsRow label="汇率来源" value={exchangeRateSourceLabel(settings?.exchangeRate?.source)} />
        <ManagedSelect label="Plugin API" value={String(managedSettings.advanced.pluginApiEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.plugin-api", value === "true", "Plugin API")} />
        <SettingsRow label="配置修订" value={managedSettings.revision.slice(0, 12)} code />
      </CardContent>
    </Card>
}

function exchangeRateSourceLabel(value: NonNullable<SettingsResponse["exchangeRate"]>["source"] | undefined): string {
  if (value === "open-er-api") return "Open Exchange Rate API"
  if (value === "ecb") return "欧洲中央银行"
  return value === "cache" ? "本地缓存" : "暂无"
}
