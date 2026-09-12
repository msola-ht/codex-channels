import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, PendingSettingDialog, SettingsRow } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { CodexSettingsController } from "@/lib/settings-management"

export function AppServerSettingsCard({ management, onChanged }: { management: CodexSettingsController; onChanged?: () => void }) {
  const settings = management.codexSettings
  const [contextWindow, setContextWindow] = useState("")
  const [compactPercent, setCompactPercent] = useState("")
  const [planEffort, setPlanEffort] = useState("")
  const [reasoningSummary, setReasoningSummary] = useState("auto")
  const [verbosity, setVerbosity] = useState("medium")
  const [personality, setPersonality] = useState("none")
  const [startupUpdate, setStartupUpdate] = useState("true")
  const [historyPersistence, setHistoryPersistence] = useState("save-all")
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (settings === null || management.pendingSetting !== null) return
    const selected = settings.models.find((model) => model.model === settings.defaults.model) ?? settings.models[0]
    setContextWindow(settings.compact.contextWindow === null ? "" : String(settings.compact.contextWindow))
    setCompactPercent(settings.compact.autoCompactPercent === null ? "" : String(settings.compact.autoCompactPercent))
    setPlanEffort(settings.defaults.planModeReasoningEffort ?? selected?.defaultReasoningEffort ?? "")
    setReasoningSummary(settings.defaults.reasoningSummary ?? "auto")
    setVerbosity(settings.defaults.verbosity ?? "medium")
    setPersonality(settings.defaults.personality ?? "none")
    setStartupUpdate(String(settings.defaults.checkForUpdateOnStartup ?? true))
    setHistoryPersistence(settings.defaults.historyPersistence ?? "save-all")
    setLocalError(null)
  }, [management.pendingSetting, settings])

  if (management.loading && settings === null) return <LoadingSettingsCard title="App Server 设置" />
  if (settings === null) return <SettingsError message={management.error ?? "App Server 用户设置暂不可用"} retry={management.refetch} />

  const confirmSetting = async () => {
    if (await management.confirmSetting()) onChanged?.()
  }
  const selected = settings.models.find((model) => model.model === settings.defaults.model) ?? settings.models[0]
  const effortOptions = selected?.reasoningEfforts.map((item) => [item.effort, item.effort]) ?? []
  const busy = management.loading || management.saving || management.pendingSetting !== null
  const officialDisabled = busy || !settings.defaultsEditable

  const saveCompact = () => {
    const parsedWindow = contextWindow.trim() === "" ? null : Number(contextWindow)
    const parsedPercent = compactPercent.trim() === "" ? null : Number(compactPercent)
    if (parsedWindow !== null && (!Number.isSafeInteger(parsedWindow) || parsedWindow <= 0)) {
      setLocalError("模型上下文窗口必须是正整数")
      return
    }
    if (parsedPercent !== null && (!Number.isInteger(parsedPercent) || parsedPercent < 10 || parsedPercent > 90)) {
      setLocalError("自动压缩百分比必须是 10–90 的整数")
      return
    }
    if (parsedPercent !== null && parsedWindow === null) {
      setLocalError("设置自动压缩百分比前必须先设置模型上下文窗口")
      return
    }
    setLocalError(null)
    void management.previewSetting({ kind: "model-compact", contextWindow: parsedWindow, autoCompactPercent: parsedPercent }, "模型上下文与自动压缩")
  }

  const savePreferences = () => {
    if (planEffort === "") {
      setLocalError("当前没有可用的 Plan 思考等级")
      return
    }
    setLocalError(null)
    void management.previewSetting({
      kind: "preferences",
      planModeReasoningEffort: planEffort,
      reasoningSummary,
      verbosity,
      personality,
      checkForUpdateOnStartup: startupUpdate === "true",
      historyPersistence,
    }, "其他用户偏好")
  }

  return <>
    <PendingSettingDialog pending={management.pendingSetting} saving={management.saving} onConfirm={() => void confirmSetting()} onCancel={management.cancelSetting} />
    <Card>
      <CardHeader><CardTitle>App Server 设置</CardTitle><CardDescription>通过 App Server 用户配置 RPC 写入，修订冲突会要求重新读取；写入后需重启全部服务生效。</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-5 text-sm">
        <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <SettingsRow label="当前 Provider" value={settings.provider} badge />
          <ManagedSelect label="默认模型" value={settings.defaults.model ?? ""} options={settings.models.map((model) => [model.model, model.displayName])} disabled={officialDisabled} onChange={(value) => { const model = settings.models.find((candidate) => candidate.model === value); void management.previewSetting({ kind: "defaults", model: value, reasoningEffort: model?.defaultReasoningEffort ?? "medium" }, "默认模型") }} />
          <ManagedSelect label="思考等级" value={settings.defaults.reasoningEffort ?? ""} options={effortOptions} disabled={officialDisabled || selected === undefined} onChange={(value) => void management.previewSetting({ kind: "defaults", model: selected?.model ?? "", reasoningEffort: value }, "思考等级")} />
          <ManagedSelect label="Fast" value={String(settings.defaults.fastEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={officialDisabled} onChange={(value) => void management.previewSetting({ kind: "fast", enabled: value === "true" }, "Fast")} />
          <ManagedSelect label="联网搜索" value={settings.defaults.webSearch ?? "disabled"} options={[["live", "实时"], ["indexed", "索引"], ["cached", "缓存"], ["disabled", "关闭"]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "web-search", mode: value }, "联网搜索")} />
          <ManagedSelect label="计划清单工具" value={String(settings.defaults.updatePlanEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "update-plan", enabled: value === "true" }, "计划清单工具")} />
          <ManagedSelect label="实验性上下文管理" value={String(settings.defaults.contextManagementEnabled)} options={[["false", "关闭"], ["true", "开启"]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "context-management", enabled: value === "true" }, "实验性上下文管理")} />
          <ManagedSelect label="空闲总结" value={String(settings.defaults.autoRecapEnabled)} options={[["false", "关闭"], ["true", "开启"]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "auto-recap", enabled: value === "true" }, "空闲总结")} />
          <ManagedSelect label="Sandbox" value={settings.permissions.sandboxMode ?? "read-only"} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: value, approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: settings.permissions.networkAccess ?? false }, "Sandbox")} />
          <ManagedSelect label="审批策略" value={settings.permissions.approvalPolicy ?? "on-request"} options={[["on-request", "按需"], ["never", "从不"]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: value, networkAccess: settings.permissions.networkAccess ?? false }, "审批策略")} />
          <ManagedSelect label="网络访问" value={String(settings.permissions.networkAccess ?? false)} options={[["true", "已允许"], ["false", "已禁止"]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: value === "true" }, "网络访问")} />
          <SettingsRow label="Permission Profile" value={settings.permissions.defaultPermissions ?? "未配置"} code />
        </FieldGroup>

        <Separator />
        <section className="flex flex-col gap-3">
          <div><h3 className="font-medium">模型上下文与自动压缩</h3><p className="text-xs text-muted-foreground">留空恢复模型默认；自动压缩百分比要求同时设置上下文窗口。</p></div>
          <FieldGroup className="grid gap-3 md:grid-cols-2">
            <Field data-disabled={officialDisabled}><FieldLabel htmlFor="codex-context-window">上下文窗口（tokens）</FieldLabel><Input id="codex-context-window" type="number" min={1} value={contextWindow} disabled={officialDisabled} onChange={(event) => setContextWindow(event.target.value)} placeholder="模型默认" /></Field>
            <Field data-disabled={officialDisabled}><FieldLabel htmlFor="codex-compact-percent">自动压缩百分比</FieldLabel><Input id="codex-compact-percent" type="number" min={10} max={90} value={compactPercent} disabled={officialDisabled} onChange={(event) => setCompactPercent(event.target.value)} placeholder="默认 95%" /></Field>
          </FieldGroup>
          <Button className="self-start" variant="outline" disabled={officialDisabled} onClick={saveCompact}>保存压缩设置</Button>
        </section>

        <Separator />
        <section className="flex flex-col gap-3">
          <div><h3 className="font-medium">其他用户偏好</h3><p className="text-xs text-muted-foreground">这些字段作为一组写入 Codex 用户配置。</p></div>
          <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            <ManagedSelect label="Plan 思考等级" value={planEffort} options={effortOptions} disabled={officialDisabled} onChange={setPlanEffort} />
            <ManagedSelect label="推理摘要" value={reasoningSummary} options={[["auto", "自动"], ["concise", "简洁"], ["detailed", "详细"], ["none", "关闭"]]} disabled={officialDisabled} onChange={setReasoningSummary} />
            <ManagedSelect label="输出详细程度" value={verbosity} options={[["low", "低"], ["medium", "中"], ["high", "高"]]} disabled={officialDisabled} onChange={setVerbosity} />
            <ManagedSelect label="模型人格" value={personality} options={[["none", "无"], ["friendly", "友好"], ["pragmatic", "务实"]]} disabled={officialDisabled} onChange={setPersonality} />
            <ManagedSelect label="启动时检查更新" value={startupUpdate} options={[["true", "开启"], ["false", "关闭"]]} disabled={officialDisabled} onChange={setStartupUpdate} />
            <ManagedSelect label="历史记录保存" value={historyPersistence} options={[["save-all", "保存"], ["none", "不保存"]]} disabled={officialDisabled} onChange={setHistoryPersistence} />
          </FieldGroup>
          <Button className="self-start" variant="outline" disabled={officialDisabled || planEffort === ""} onClick={savePreferences}>保存用户偏好</Button>
        </section>

        {localError !== null ? <Alert variant="destructive"><AlertDescription>{localError}</AlertDescription></Alert> : null}
        {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  </>
}
