import { useEffect, useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ManagedSelect } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"

export function ProviderSettingsManagement({ management }: { management: ProviderSettingsController }) {
  const settings = management.settings
  if (management.loading) return <LoadingSettingsCard title="Provider 设置" />
  if (settings === null) return <SettingsError message={management.error ?? "Provider 设置暂不可用"} retry={management.refetch} />
  return <ProviderSettingsCard settings={settings} management={management} />
}

function ProviderSettingsCard({
  settings,
  management,
}: {
  settings: ManagementProviderSettingsResponse
  management: ProviderSettingsController
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState("")
  const [providerName, setProviderName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [mode, setMode] = useState<"switching" | "exclusive">("switching")
  const [model, setModel] = useState("")
  const [supportsWebsockets, setSupportsWebsockets] = useState("true")
  const [apiKey, setApiKey] = useState("")
  const [confirmRemoveBaseUrl, setConfirmRemoveBaseUrl] = useState(false)
  const [managedProvider, setManagedProvider] = useState(settings.managedProviders[0]?.id ?? "")
  const [managedModel, setManagedModel] = useState(settings.managedProviders[0]?.model ?? "")
  const [managedReasoning, setManagedReasoning] = useState(settings.managedProviders[0]?.reasoningEffort ?? "")
  const [autoCompactPercent, setAutoCompactPercent] = useState("60")
  const [agentProvider, setAgentProvider] = useState(settings.externalAgent.status === "configured" ? settings.externalAgent.provider : settings.managedProviders[0]?.id ?? settings.customProviders.switchingProviders[0]?.id ?? "")
  const [agentModel, setAgentModel] = useState(settings.externalAgent.status === "configured" ? settings.externalAgent.model : settings.managedProviders[0]?.models[0]?.id ?? settings.customProviders.switchingProviders[0]?.model ?? "")

  const managed = settings.managedProviders.find((provider) => provider.id === managedProvider) ?? settings.managedProviders[0]
  const managedModelEntry = managed?.models.find((candidate) => candidate.id === managedModel) ?? managed?.models[0]
  const agentProviders = useMemo(() => {
    const providers = new Map<string, { id: string; displayName: string; models: Array<{ id: string; displayName: string }> }>()
    settings.managedProviders.forEach((provider) => {
      providers.set(provider.id, {
        id: provider.id,
        displayName: provider.displayName,
        models: provider.models.map((candidate) => ({ id: candidate.id, displayName: candidate.displayName })),
      })
    })
    settings.customProviders.switchingProviders.forEach((provider) => {
      if (!providers.has(provider.id)) {
        providers.set(provider.id, {
          id: provider.id,
          displayName: provider.displayName,
          models: [{ id: provider.model, displayName: provider.model }],
        })
      }
    })
    const activeFixed = settings.customProviders.fixedCandidates.find((provider) => provider.active)
    if (activeFixed !== undefined && settings.defaults.model !== null && !providers.has(activeFixed.id)) {
      providers.set(activeFixed.id, {
        id: activeFixed.id,
        displayName: activeFixed.displayName,
        models: [{ id: settings.defaults.model, displayName: settings.defaults.model }],
      })
    }
    return [...providers.values()]
  }, [settings.customProviders.fixedCandidates, settings.customProviders.switchingProviders, settings.defaults.model, settings.managedProviders])
  const agentProviderEntry = agentProviders.find((provider) => provider.id === agentProvider) ?? agentProviders[0]
  const agentModels = useMemo(() => agentProviderEntry?.models ?? [], [agentProviderEntry])
  const candidates = useMemo(() => [
    ...settings.customProviders.fixedCandidates,
    ...settings.customProviders.switchingProviders,
    ...settings.customProviders.backupCandidates,
  ], [settings.customProviders])
  const busy = management.busy
  const pending = management.pendingPreview

  useEffect(() => {
    if (managed === undefined) return
    setManagedModel((current) => managed.models.some((candidate) => candidate.id === current) ? current : managed.model)
    setManagedReasoning((current) => current || managed.reasoningEffort)
    const selected = managed.models.find((candidate) => candidate.id === managedModel)
    setAutoCompactPercent(String(selected?.autoCompactPercent ?? 60))
  }, [managed, managedModel])

  useEffect(() => {
    if (agentProviderEntry === undefined) return
    const configured = settings.externalAgent.status === "configured" ? settings.externalAgent : null
    setAgentProvider((current) => agentProviders.some((provider) => provider.id === current) ? current : configured?.provider ?? agentProviderEntry.id)
    setAgentModel((current) => agentModels.some((modelOption) => modelOption.id === current) ? current : configured?.model ?? agentModels[0]?.id ?? "")
  }, [agentModels, agentProviderEntry, agentProviders, settings.externalAgent])

  const resetForm = () => {
    setEditingId(null)
    setProviderId("")
    setProviderName("")
    setBaseUrl("")
    setMode("switching")
    setModel("")
    setSupportsWebsockets("true")
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
  }

  const edit = (candidate: typeof candidates[number]) => {
    setEditingId(candidate.id)
    setProviderId(candidate.id)
    setProviderName(candidate.displayName)
    setBaseUrl(candidate.baseUrl)
    setMode("mode" in candidate && candidate.mode === "switching" ? "switching" : "exclusive")
    setModel("model" in candidate && typeof candidate.model === "string" ? candidate.model : settings.defaults.model ?? "")
    setSupportsWebsockets("supportsWebsockets" in candidate && candidate.supportsWebsockets ? "true" : "false")
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
    management.clearError()
  }

  const saveCustom = async () => {
    const credential = apiKey.trim() === ""
      ? { action: "preserve" as const }
      : { action: "replace" as const, apiKey }
    const result = await management.mutate({
      operation: "primary.custom.save",
      provider: {
        operation: editingId === null ? "create" : "update",
        providerId: providerId.trim(),
        name: providerName.trim(),
        baseUrl: baseUrl.trim(),
        mode,
        model: model.trim(),
        supportsWebsockets: supportsWebsockets === "true",
        credential,
        ...(confirmRemoveBaseUrl ? { confirmRemoveTopLevelBaseUrl: true } : {}),
      },
    })
    if (result !== null) resetForm()
  }

  const switchProvider = async (providerIdToSwitch: string) => {
    await management.mutate({ operation: "primary.switch", providerId: providerIdToSwitch })
  }

  const removeProvider = async (providerIdToRemove: string) => {
    await management.mutate({ operation: "primary.remove", providerId: providerIdToRemove })
  }

  const updateManagedDefault = async () => {
    if (managed === undefined || managedModelEntry === undefined) return
    await management.mutate({
      operation: "managed.default",
      provider: managed.id,
      model: managedModelEntry.id,
      reasoningEffort: managedReasoning,
      autoCompactPercent: Number(autoCompactPercent),
    })
  }

  const configureAgent = async () => {
    if (agentProviderEntry === undefined || agentModel === "") return
    await management.mutate({ operation: "external-agent", action: "configure", provider: agentProviderEntry.id, model: agentModel })
  }

  const disableAgent = async () => {
    await management.mutate({ operation: "external-agent", action: "disable" })
  }

  const confirmPending = async () => {
    const operation = management.pendingPreview?.input.operation
    const result = await management.confirm()
    if (result !== null && operation === "primary.custom.save") resetForm()
  }

  return <Card>
    <CardHeader>
      <CardTitle>Provider 设置</CardTitle>
      <CardDescription>托管 Provider 默认值和自定义主 Provider 共用结构化预览、一次性确认和原子事务；凭据只写入，不回显。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-medium">托管 Provider 默认值</h3><p className="text-xs text-muted-foreground">修改模型目录中的默认模型、思考等级和自动压缩阈值。</p></div>
          <Badge variant="outline">{settings.managedProviders.length} 个</Badge>
        </div>
        {managed === undefined ? <p className="text-muted-foreground">当前没有已配置的托管 Provider。</p> : <>
          <ManagedSelect label="Provider" value={managed.id} options={settings.managedProviders.map((provider) => [provider.id, provider.displayName])} disabled={busy || pending !== null} onChange={(value) => { setManagedProvider(value); const next = settings.managedProviders.find((candidate) => candidate.id === value); if (next !== undefined) { setManagedModel(next.model); setManagedReasoning(next.reasoningEffort) } }} />
          <ManagedSelect label="默认模型" value={managedModel} options={managed.models.map((candidate) => [candidate.id, candidate.displayName])} disabled={busy || pending !== null} onChange={setManagedModel} />
          <ManagedSelect label="思考等级" value={managedReasoning} options={(managedModelEntry?.reasoningEfforts ?? []).map((candidate) => [candidate.effort, candidate.effort])} disabled={busy || pending !== null} onChange={setManagedReasoning} />
          <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">自动压缩百分比</span><Input className="w-[160px]" type="number" min={10} max={90} value={autoCompactPercent} disabled={busy || pending !== null} onChange={(event) => setAutoCompactPercent(event.target.value)} /></div>
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || managedModelEntry === undefined} onClick={() => void updateManagedDefault()}>保存托管 Provider 默认值</Button>
        </>}
      </section>
      <section className="flex flex-col gap-3 border-t pt-5">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-medium">共享第三方子代理</h3><p className="text-xs text-muted-foreground">配置或停用 agents.external；修改后需要重启全部服务。</p></div>
          <Badge variant="outline">{settings.externalAgent.status === "configured" ? "已配置" : "未配置"}</Badge>
        </div>
        {agentProviderEntry === undefined ? <p className="text-muted-foreground">尚未配置可用的第三方 Provider。</p> : <>
          <ManagedSelect label="Provider" value={agentProviderEntry.id} options={agentProviders.map((provider) => [provider.id, provider.displayName])} disabled={busy || pending !== null} onChange={(value) => { setAgentProvider(value); const next = agentProviders.find((provider) => provider.id === value); setAgentModel(next?.models[0]?.id ?? "") }} />
          <ManagedSelect label="模型" value={agentModel} options={agentModels.map((candidate) => [candidate.id, candidate.displayName])} disabled={busy || pending !== null} onChange={setAgentModel} />
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || agentModel === ""} onClick={() => void configureAgent()}>保存子代理设置</Button>
        </>}
        {settings.externalAgent.status === "configured" ? <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => void disableAgent()}>停用共享子代理</Button> : null}
      </section>
      <section className="flex flex-col gap-3 border-t pt-5">
        <div><h3 className="font-medium">自定义主 Provider</h3><p className="text-xs text-muted-foreground">可切换模式保留官方主 Provider；固定模式会修改 Codex 主配置并需要重启全部服务。</p></div>
        {candidates.length === 0 ? <p className="text-muted-foreground">当前没有自定义主 Provider。</p> : candidates.map((candidate) => <div key={`${candidate.id}:${candidate.baseUrl}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2"><div className="min-w-0"><div className="font-medium">{candidate.displayName} {"active" in candidate && candidate.active ? <Badge variant="secondary">当前</Badge> : null}</div><div className="truncate text-xs text-muted-foreground">{candidate.id} · {candidate.baseUrl || "地址未返回"}</div></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => edit(candidate)}>编辑</Button><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => void switchProvider(candidate.id)}>切换</Button><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => void removeProvider(candidate.id)}>删除</Button></div></div>)}
        <div className="grid gap-2 md:grid-cols-2"><Input placeholder="Provider ID" value={providerId} disabled={busy || pending !== null || editingId !== null} onChange={(event) => setProviderId(event.target.value)} /><Input placeholder="显示名称" value={providerName} disabled={busy || pending !== null} onChange={(event) => setProviderName(event.target.value)} /><Input className="md:col-span-2" placeholder="Responses Endpoint（HTTPS）" value={baseUrl} disabled={busy || pending !== null} onChange={(event) => setBaseUrl(event.target.value)} /><Input placeholder="模型 ID" value={model} disabled={busy || pending !== null} onChange={(event) => setModel(event.target.value)} /><ManagedSelect label="运行模式" value={mode} options={[["switching", "可切换"], ["exclusive", "固定主 Provider"]]} disabled={busy || pending !== null} onChange={(value) => setMode(value as "switching" | "exclusive")} /><ManagedSelect label="WebSocket" value={supportsWebsockets} options={[["true", "支持"], ["false", "不支持"]]} disabled={busy || pending !== null} onChange={setSupportsWebsockets} /><Input className="md:col-span-2" type="password" autoComplete="new-password" placeholder="API Key（留空沿用已有凭据）" value={apiKey} disabled={busy || pending !== null} onChange={(event) => setApiKey(event.target.value)} /></div>
        {mode === "exclusive" ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={confirmRemoveBaseUrl} disabled={busy || pending !== null} onCheckedChange={(checked) => setConfirmRemoveBaseUrl(checked === true)} />确认固定模式需要时移除顶层 openai_base_url</label> : null}
        <div className="flex gap-2"><Button disabled={busy || pending !== null || providerId.trim() === "" || providerName.trim() === "" || baseUrl.trim() === "" || model.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void saveCustom()}>{editingId === null ? "新增自定义 Provider" : "保存自定义 Provider"}</Button>{editingId !== null ? <Button variant="outline" disabled={busy || pending !== null} onClick={resetForm}>取消编辑</Button> : null}<Button variant="outline" disabled={busy || pending !== null} onClick={() => void switchProvider("openai")}>切回官方 OpenAI</Button></div>
      </section>
      {pending !== null ? <ProviderSettingsConfirmationCard pending={pending.preview} saving={busy} onConfirm={() => void confirmPending()} onCancel={management.cancel} /> : null}
      {management.actionError !== null ? <p className="text-destructive" role="status">{management.actionError}</p> : null}
    </CardContent>
  </Card>
}

function ProviderSettingsConfirmationCard({
  pending,
  saving,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<ProviderSettingsController["pendingPreview"]>["preview"]
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const lines = [`操作：${pending.operation}`]
  if (pending.provider !== undefined) lines.push(`Provider：${pending.provider.displayName ?? pending.provider.name ?? pending.provider.id}`)
  if (pending.target !== undefined) lines.push(`目标：${pending.target.displayName}（${pending.target.id}）`)
  if (pending.selection !== undefined) lines.push(`选择：${pending.selection.providerDisplayName ?? pending.selection.provider} / ${pending.selection.modelDisplayName ?? pending.selection.model}`)
  if (pending.model !== undefined) lines.push(`模型：${pending.model.displayName}（${pending.model.id}）`)
  if (pending.reasoningEffort !== undefined) lines.push(`思考等级：${pending.reasoningEffort}`)
  if (pending.autoCompactPercent !== undefined) lines.push(`自动压缩：${pending.autoCompactPercent}%`)
  if (pending.credential?.action !== undefined) lines.push(`凭据：${pending.credential.action === "replace" ? "写入新 API Key" : "沿用已有 API Key"}`)
  if (pending.current !== undefined) lines.push(`当前：${pending.current.configured ? `${pending.current.provider ?? "未知"} / ${pending.current.model ?? "未知"}` : "未配置"}`)
  return <Card className="border-primary/40"><CardHeader><CardTitle className="text-base">确认 Provider 配置修改</CardTitle><CardDescription>确认后写入对应配置，不会自动执行生效目标。</CardDescription></CardHeader><CardContent className="text-sm"><p className="whitespace-pre-line">{lines.join("\n")}</p><p className="mt-1 text-muted-foreground">生效目标：{pending.activation}</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={saving} onClick={onConfirm}>确认写入</Button><Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>取消</Button></div></CardContent></Card>
}
