import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedInputRow, ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { UseApiState } from "@/hooks/use-api"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { UpstreamUserAgentResponse } from "@/lib/types"

export function GatewaySettingsCard({ management, upstreamAgent }: {
  management: GatewaySettingsController
  upstreamAgent: UseApiState<UpstreamUserAgentResponse>
}) {
  const managedSettings = management.managedSettings
  const [identityName, setIdentityName] = useState("")
  const [identityTitle, setIdentityTitle] = useState("")
  const [identityVersion, setIdentityVersion] = useState("")
  const [upstreamUserAgent, setUpstreamUserAgent] = useState("")
  const [terminalIdentity, setTerminalIdentity] = useState("")

  useEffect(() => {
    if (managedSettings === null || management.pendingSetting !== null) return
    setIdentityName(managedSettings.system.officialTuiIdentity.clientIdentity.name ?? "")
    setIdentityTitle(managedSettings.system.officialTuiIdentity.clientIdentity.title ?? "")
    setIdentityVersion(managedSettings.system.officialTuiIdentity.clientIdentity.version ?? "")
    setUpstreamUserAgent(managedSettings.system.officialTuiIdentity.upstreamUserAgent ?? "")
    setTerminalIdentity(managedSettings.system.officialTuiIdentity.terminalIdentity ?? "")
  }, [managedSettings, management.pendingSetting])

  if (managedSettings === null) return null
  const disabled = management.saving || management.pendingSetting !== null
  const identityDefaults = managedSettings.system.officialTuiIdentity.defaults
  const effectiveUserAgent = upstreamAgent.data?.effectiveUserAgent ?? null
  const recentRequestUserAgent = upstreamAgent.data?.recentRequestUserAgent ?? null
  const upstreamAgentValue = upstreamAgent.error !== null
    ? `读取失败：${upstreamAgent.error}`
    : upstreamAgent.data === null
      ? "读取中…"
      : effectiveUserAgent ?? "不可用：App Server 未运行，且未配置覆盖"
  const upstreamAgentSource = upstreamAgent.error !== null || upstreamAgent.data === null
    ? null
    : upstreamAgent.data.source === "override"
      ? "显式覆盖"
      : upstreamAgent.data.source === "app-server" ? "App Server 生成" : null
  const upstreamAgentState = effectiveUserAgent === null || recentRequestUserAgent === null
    ? null
    : recentRequestUserAgent === effectiveUserAgent
      ? "已生效（与最近一次请求一致）"
      : upstreamAgent.data?.source === "override"
        ? "配置已保存，重启后生效"
        : "与最近一次请求不一致"
  const saveIdentity = () => {
    void management.previewSetting("system.official-tui-identity", {
      clientIdentity: {
        name: identityName.trim() || null,
        title: identityTitle.trim() || null,
        version: identityVersion.trim() || null,
      },
      upstreamUserAgent: upstreamUserAgent.trim() || null,
      terminalIdentity: terminalIdentity.trim() || null,
    }, "官方 TUI 请求身份")
  }

  return <Card>
    <CardHeader><CardTitle>Gateway 设置</CardTitle><CardDescription>Gateway 渠道、系统、显示、自动化和运行日志；当前值与修改入口在同一分区。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5 text-sm">
      <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        <ManagedSelect label="Sandbox" value={managedSettings.system.sandbox} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={disabled} onChange={(value) => void management.previewSetting("system.sandbox", value, "Sandbox")} />
        <ManagedInputRow key={"approval-" + managedSettings.revision} label="审批超时（秒）" type="number" defaultValue={String(managedSettings.system.approvalTimeoutSeconds)} placeholder="30–3600" disabled={disabled} onBlur={(value) => void management.previewSetting("system.approval-timeout", Number(value), "审批超时")} />
        <ManagedInputRow key={"idle-" + managedSettings.revision} label="空闲自动解除（分钟）" type="number" defaultValue={String(managedSettings.system.idleReleaseMinutes)} placeholder="0–1440，0 为关闭" disabled={disabled} onBlur={(value) => void management.previewSetting("system.idle-release-minutes", Number(value), "空闲自动解除")} />
        <ManagedInputRow key={"model-" + managedSettings.revision} label="渠道新会话模型" defaultValue={managedSettings.system.defaultModel ?? ""} placeholder="留空跟随 Codex 全局默认" disabled={disabled} onBlur={(value) => void management.previewSetting("system.default-model", value === "" ? null : value, "渠道新会话模型")} />
        <ManagedSelect label="模型请求转储" value={String(managedSettings.system.modelTrafficDumpEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("system.model-traffic-dump", value === "true", "模型请求转储")} />
        <ManagedInputRow key={"traffic-retention-" + managedSettings.revision} label="转储保留天数" type="number" defaultValue={String(managedSettings.system.modelTrafficRetentionDays)} placeholder="0–36500，0 为关闭" disabled={disabled} onBlur={(value) => void management.previewSetting("system.model-traffic-retention-days", Number(value), "转储保留天数")} />
        <ManagedSelect label="默认 Workspace" value={managedSettings.system.defaultWorkspace ?? ""} options={managedSettings.system.workspaces.map((workspace) => [workspace.id, workspace.name])} disabled={disabled || managedSettings.system.workspaces.length === 0} onChange={(value) => void management.previewSetting("system.default-workspace", value, "默认 Workspace")} />
        <ManagedSelect label="Telegram 消息格式" value={managedSettings.telegram.messageFormat} options={[["html", "HTML"], ["rich", "富文本"]]} disabled={disabled || !managedSettings.telegram.configured} onChange={(value) => void management.previewSetting("telegram.message-format", value, "Telegram 消息格式")} />
        <ManagedSelect label="操作详情" value={managedSettings.display.operationUpdates} options={[["full", "完整"], ["compact", "紧凑"], ["hidden", "隐藏"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.operation-updates", value, "操作详情")} />
        <ManagedSelect label="计划更新" value={String(managedSettings.display.planUpdatesEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.plan-updates", value === "true", "计划更新")} />
        <ManagedSelect label="思考状态" value={String(managedSettings.display.reasoningEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.reasoning", value === "true", "思考状态")} />
        <ManagedSelect label="计划任务" value={String(managedSettings.automation.scheduledTasksEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("automation.scheduled-tasks", value === "true", "计划任务")} />
        <ManagedSelect label="日志等级" value={managedSettings.advanced.loggingLevel} options={[["fatal", "fatal"], ["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"], ["trace", "trace"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.logging-level", value, "日志等级")} />
        <ManagedSelect label="Plugin API" value={String(managedSettings.advanced.pluginApiEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.plugin-api", value === "true", "Plugin API")} />
        <SettingsRow label="配置修订" value={managedSettings.revision.slice(0, 12)} code />
      </FieldGroup>

      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">官方 TUI 请求身份</h3><p className="text-xs text-muted-foreground">客户端身份、终端标识和上游 User-Agent 作为一组写入；全部留空使用默认官方 TUI 身份 {identityDefaults.name} / {identityDefaults.version} 并跟随 Codex CLI 升级，填写后写死为显式覆盖。</p></div>
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field data-disabled={disabled}><FieldLabel htmlFor="tui-identity-name">名称</FieldLabel><Input id="tui-identity-name" value={identityName} disabled={disabled} maxLength={64} onChange={(event) => setIdentityName(event.target.value)} placeholder={identityDefaults.name} /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor="tui-identity-title">标题</FieldLabel><Input id="tui-identity-title" value={identityTitle} disabled={disabled} maxLength={128} onChange={(event) => setIdentityTitle(event.target.value)} placeholder="可选" /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor="tui-identity-version">版本</FieldLabel><Input id="tui-identity-version" value={identityVersion} disabled={disabled} maxLength={64} onChange={(event) => setIdentityVersion(event.target.value)} placeholder={identityDefaults.version} /></Field>
        </FieldGroup>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="tui-terminal-identity">终端标识</FieldLabel>
          <Input id="tui-terminal-identity" value={terminalIdentity} disabled={disabled} maxLength={64} onChange={(event) => setTerminalIdentity(event.target.value)} placeholder="留空由 App Server 自行探测" />
          <FieldDescription>App Server 由服务进程启动、自身没有终端，缺省时模型上游 UA 的终端标识为 unknown；通常由 codexc config、安装或更新服务时按运行命令的终端自动写入，也可在此填写「终端名」或「终端名/版本」（如 iTerm.app/3.5.14），写入其进程环境并在重启后生效。</FieldDescription>
        </Field>
        <Field data-disabled={disabled}><FieldLabel htmlFor="tui-upstream-user-agent">上游 User-Agent</FieldLabel><Input id="tui-upstream-user-agent" value={upstreamUserAgent} disabled={disabled} maxLength={512} onChange={(event) => setUpstreamUserAgent(event.target.value)} placeholder="留空透传官方 TUI UA" /></Field>
        <Button className="self-start" variant="outline" disabled={disabled} onClick={saveIdentity}>保存请求身份</Button>
        <SettingsRow label="当前模型上游 User-Agent" value={upstreamAgentValue} code />
        {upstreamAgentSource === null ? null : <SettingsRow label="UA 取值来源" value={upstreamAgentSource} />}
        <SettingsRow
          label="最近一次请求实际使用"
          value={recentRequestUserAgent ?? "无请求样本"}
          code={recentRequestUserAgent !== null}
        />
        {upstreamAgentState === null ? null : <SettingsRow label="生效状态" value={upstreamAgentState} />}
      </section>
    </CardContent>
  </Card>
}
