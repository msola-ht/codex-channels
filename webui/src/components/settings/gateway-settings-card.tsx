import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { ManagedInputRow, ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"

export function GatewaySettingsCard({ management }: { management: GatewaySettingsController }) {
  const managedSettings = management.managedSettings
  const [identityName, setIdentityName] = useState("")
  const [identityTitle, setIdentityTitle] = useState("")
  const [identityVersion, setIdentityVersion] = useState("")
  const [upstreamUserAgent, setUpstreamUserAgent] = useState("")

  useEffect(() => {
    if (managedSettings === null || management.pendingSetting !== null) return
    setIdentityName(managedSettings.system.officialTuiIdentity.clientIdentity.name ?? "")
    setIdentityTitle(managedSettings.system.officialTuiIdentity.clientIdentity.title ?? "")
    setIdentityVersion(managedSettings.system.officialTuiIdentity.clientIdentity.version ?? "")
    setUpstreamUserAgent(managedSettings.system.officialTuiIdentity.upstreamUserAgent ?? "")
  }, [managedSettings, management.pendingSetting])

  if (managedSettings === null) return null
  const disabled = management.saving || management.pendingSetting !== null
  const saveIdentity = () => {
    void management.previewSetting("system.official-tui-identity", {
      clientIdentity: {
        name: identityName.trim() || null,
        title: identityTitle.trim() || null,
        version: identityVersion.trim() || null,
      },
      upstreamUserAgent: upstreamUserAgent.trim() || null,
    }, "官方 TUI 请求身份")
  }

  return <Card>
    <CardHeader><CardTitle>Gateway 设置</CardTitle><CardDescription>Gateway 渠道、系统、显示、自动化和运行日志；当前值与修改入口在同一分区。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5 text-sm">
      <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        <ManagedSelect label="Sandbox" value={managedSettings.system.sandbox} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={disabled} onChange={(value) => void management.previewSetting("system.sandbox", value, "Sandbox")} />
        <ManagedInputRow key={"approval-" + managedSettings.revision} label="审批超时（秒）" type="number" defaultValue={String(managedSettings.system.approvalTimeoutSeconds)} placeholder="30–3600" disabled={disabled} onBlur={(value) => void management.previewSetting("system.approval-timeout", Number(value), "审批超时")} />
        <ManagedInputRow key={"idle-" + managedSettings.revision} label="空闲自动解除（分钟）" type="number" defaultValue={String(managedSettings.system.idleReleaseMinutes)} placeholder="0–1440，0 为关闭" disabled={disabled} onBlur={(value) => void management.previewSetting("system.idle-release-minutes", Number(value), "空闲自动解除")} />
        <ManagedInputRow key={"model-" + managedSettings.revision} label="渠道新会话模型" defaultValue={managedSettings.system.defaultModel ?? ""} placeholder="留空跟随 Codex 全局默认" disabled={disabled} onBlur={(value) => void management.previewSetting("system.default-model", value === "" ? null : value, "渠道新会话模型")} />
        <ManagedSelect label="默认 Workspace" value={managedSettings.system.defaultWorkspace ?? ""} options={managedSettings.system.workspaces.map((workspace) => [workspace.id, workspace.name])} disabled={disabled || managedSettings.system.workspaces.length === 0} onChange={(value) => void management.previewSetting("system.default-workspace", value, "默认 Workspace")} />
        <ManagedSelect label="Telegram 消息格式" value={managedSettings.telegram.messageFormat} options={[["html", "HTML"], ["rich", "富文本"]]} disabled={disabled || !managedSettings.telegram.configured} onChange={(value) => void management.previewSetting("telegram.message-format", value, "Telegram 消息格式")} />
        <ManagedSelect label="操作详情" value={managedSettings.display.operationUpdates} options={[["full", "完整"], ["compact", "紧凑"], ["hidden", "隐藏"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.operation-updates", value, "操作详情")} />
        <ManagedSelect label="计划更新" value={String(managedSettings.display.planUpdatesEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.plan-updates", value === "true", "计划更新")} />
        <ManagedSelect label="思考状态" value={String(managedSettings.display.reasoningEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.reasoning", value === "true", "思考状态")} />
        <ManagedSelect label="计划任务" value={String(managedSettings.automation.scheduledTasksEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("automation.scheduled-tasks", value === "true", "计划任务")} />
        <ManagedSelect label="日志等级" value={managedSettings.advanced.loggingLevel} options={[["fatal", "fatal"], ["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"], ["trace", "trace"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.logging-level", value, "日志等级")} />
        <ManagedSelect label="Plugin API" value={String(managedSettings.advanced.pluginApiEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.plugin-api", value === "true", "Plugin API")} />
        <SettingsRow label="配置修订" value={managedSettings.revision.slice(0, 12)} code />
      </div>

      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">官方 TUI 请求身份</h3><p className="text-xs text-muted-foreground">客户端身份和上游 User-Agent 作为一组写入；全部留空会恢复 App Server 原生透传。</p></div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="grid gap-1.5"><Label htmlFor="tui-identity-name">名称</Label><Input id="tui-identity-name" value={identityName} disabled={disabled} maxLength={64} onChange={(event) => setIdentityName(event.target.value)} placeholder="codex-tui" /></div>
          <div className="grid gap-1.5"><Label htmlFor="tui-identity-title">标题</Label><Input id="tui-identity-title" value={identityTitle} disabled={disabled} maxLength={128} onChange={(event) => setIdentityTitle(event.target.value)} placeholder="可选" /></div>
          <div className="grid gap-1.5"><Label htmlFor="tui-identity-version">版本</Label><Input id="tui-identity-version" value={identityVersion} disabled={disabled} maxLength={64} onChange={(event) => setIdentityVersion(event.target.value)} placeholder="0.153.4" /></div>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="tui-upstream-user-agent">上游 User-Agent</Label><Input id="tui-upstream-user-agent" value={upstreamUserAgent} disabled={disabled} maxLength={512} onChange={(event) => setUpstreamUserAgent(event.target.value)} placeholder="留空恢复原生透传" /></div>
        <Button className="self-start" variant="outline" disabled={disabled} onClick={saveIdentity}>保存请求身份</Button>
      </section>
    </CardContent>
  </Card>
}
