import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ManagedSelect, PendingSettingCard, SettingsRow } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { CodexSettingsController } from "@/lib/settings-management"

export function AppServerSettingsCard({ management }: { management: CodexSettingsController }) {
  const settings = management.codexSettings
  if (management.loading) return <LoadingSettingsCard title="App Server 设置" />
  if (settings === null) return <SettingsError message={management.error ?? "App Server 用户设置暂不可用"} retry={management.refetch} />
  const selected = settings.models.find((model) => model.model === settings.defaults.model) ?? settings.models[0]
  const effortOptions = selected?.reasoningEfforts.map((item) => [item.effort, item.effort]) ?? []
  const disabled = management.saving || management.pendingSetting !== null || !settings.defaultsEditable
  return <>
    {management.pendingSetting !== null ? <PendingSettingCard pending={management.pendingSetting} saving={management.saving} onConfirm={() => void management.confirmSetting()} onCancel={management.cancelSetting} /> : null}
    <Card>
      <CardHeader><CardTitle>App Server 设置</CardTitle><CardDescription>通过 App Server 用户配置 RPC 写入，修订冲突会要求重新读取；写入后需重启全部服务生效。</CardDescription></CardHeader>
      <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        <SettingsRow label="当前 Provider" value={settings.provider} badge />
        <ManagedSelect label="默认模型" value={settings.defaults.model ?? ""} options={settings.models.map((model) => [model.model, model.displayName])} disabled={disabled} onChange={(value) => { const model = settings.models.find((candidate) => candidate.model === value); void management.previewSetting({ kind: "defaults", model: value, reasoningEffort: model?.defaultReasoningEffort ?? "medium" }, "默认模型") }} />
        <ManagedSelect label="思考等级" value={settings.defaults.reasoningEffort ?? ""} options={effortOptions} disabled={disabled || selected === undefined} onChange={(value) => void management.previewSetting({ kind: "defaults", model: selected?.model ?? "", reasoningEffort: value }, "思考等级")} />
        <ManagedSelect label="Fast" value={String(settings.defaults.fastEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting({ kind: "fast", enabled: value === "true" }, "Fast")} />
        <ManagedSelect label="联网搜索" value={settings.defaults.webSearch ?? "disabled"} options={[["live", "实时"], ["indexed", "索引"], ["cached", "缓存"], ["disabled", "关闭"]]} disabled={management.saving || management.pendingSetting !== null} onChange={(value) => void management.previewSetting({ kind: "web-search", mode: value }, "联网搜索")} />
        <ManagedSelect label="计划清单工具" value={String(settings.defaults.updatePlanEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={management.saving || management.pendingSetting !== null} onChange={(value) => void management.previewSetting({ kind: "update-plan", enabled: value === "true" }, "计划清单工具")} />
        <ManagedSelect label="Sandbox" value={settings.permissions.sandboxMode ?? "read-only"} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={management.saving || management.pendingSetting !== null || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: value, approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: settings.permissions.networkAccess ?? false }, "Sandbox")} />
        <ManagedSelect label="审批策略" value={settings.permissions.approvalPolicy ?? "on-request"} options={[["on-request", "按需"], ["never", "从不"]]} disabled={management.saving || management.pendingSetting !== null || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: value, networkAccess: settings.permissions.networkAccess ?? false }, "审批策略")} />
        <ManagedSelect label="网络访问" value={String(settings.permissions.networkAccess ?? false)} options={[["true", "已允许"], ["false", "已禁止"]]} disabled={management.saving || management.pendingSetting !== null || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: value === "true" }, "网络访问")} />
        <SettingsRow label="Permission Profile" value={settings.permissions.defaultPermissions ?? "未配置"} code />
        {management.actionError !== null ? <p className="text-sm text-destructive md:col-span-2">{management.actionError}</p> : null}
      </CardContent>
    </Card>
  </>
}
