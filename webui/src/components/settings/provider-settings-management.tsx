import { useEffect, useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import { formatTokens } from "@/lib/format"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"

export function ProviderSettingsManagement({ management, onChanged }: { management: ProviderSettingsController; onChanged?: () => void }) {
  const settings = management.settings
  if (management.loading && settings === null) return <LoadingSettingsCard title="Provider 设置" />
  if (settings === null) return <SettingsError message={management.error ?? "Provider 设置暂不可用"} retry={management.refetch} />
  return <ProviderSettingsCard settings={settings} management={management} onChanged={onChanged} />
}

function ProviderSettingsCard({
  settings,
  management,
  onChanged,
}: {
  settings: ManagementProviderSettingsResponse
  management: ProviderSettingsController
  onChanged?: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState("")
  const [providerName, setProviderName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [mode, setMode] = useState<"switching" | "exclusive">("switching")
  const [model, setModel] = useState("")
  const [catalogKind, setCatalogKind] = useState("official")
  const [customModels, setCustomModels] = useState<Array<{ id: string; name: string; contextWindow: number; reasoningEfforts: string[]; defaultReasoningEffort: string | null; supportsImages: boolean; template?: {source: "official" | "deepseek"; model: string; followContext: boolean} }>>([])
  const [supportsWebsockets, setSupportsWebsockets] = useState("true")
  const [apiKey, setApiKey] = useState("")
  const [confirmRemoveBaseUrl, setConfirmRemoveBaseUrl] = useState(false)
  const [managedProvider, setManagedProvider] = useState(settings.managedProviders[0]?.id ?? "")
  const [managedModel, setManagedModel] = useState(settings.managedProviders[0]?.model ?? "")
  const [managedReasoning, setManagedReasoning] = useState(settings.managedProviders[0]?.reasoningEffort ?? "")
  const [windowModel, setWindowModel] = useState(settings.modelWindow[0]?.id ?? "")
  const [windowPercent, setWindowPercent] = useState("100")
  const [windowError, setWindowError] = useState<string | null>(null)

  const managed = settings.managedProviders.find((provider) => provider.id === managedProvider) ?? settings.managedProviders[0]
  const managedModelEntry = managed?.models.find((candidate) => candidate.id === managedModel) ?? managed?.models[0]
  const windowEntry = settings.modelWindow.find((candidate) => candidate.id === windowModel) ?? settings.modelWindow[0]
  const candidates = useMemo(() => [
    ...settings.customProviders.fixedCandidates,
    ...settings.customProviders.switchingProviders,
    ...settings.customProviders.backupCandidates,
  ], [settings.customProviders])
  const busy = management.busy || management.loading
  const pending = management.pendingPreview

  useEffect(() => {
    if (managed === undefined) return
    setManagedModel((current) => managed.models.some((candidate) => candidate.id === current) ? current : managed.model)
    setManagedReasoning((current) => current || managed.reasoningEffort)
  }, [managed])

  useEffect(() => {
    if (windowEntry === undefined) return
    setWindowModel((current) => settings.modelWindow.some((candidate) => candidate.id === current) ? current : windowEntry.id)
    setWindowPercent(String(windowEntry.windowPercent ?? 100))
  }, [windowEntry, settings.modelWindow])


  const resetForm = () => {
    setEditingId(null)
    setProviderId("")
    setProviderName("")
    setBaseUrl("")
    setMode("switching")
    setModel("")
    setCatalogKind("official")
    setCustomModels([])
    setSupportsWebsockets("true")
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
  }

  const edit = (candidate: typeof candidates[number]) => {
    setCatalogKind(candidate.catalog === "custom" ? "custom" : "official")
    setCustomModels(candidate.models?.map(entry => ({ ...entry, reasoningEfforts: [...entry.reasoningEfforts] })) ?? [])
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
        ...(catalogKind === "custom" ? { catalog: { kind: "custom" as const, models: customModels } } : {}),
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
    })
  }

  const updateWindow = async () => {
    if (windowEntry === undefined) return
    const parsedPercent = Number(windowPercent)
    if (!Number.isInteger(parsedPercent) || parsedPercent < 10 || parsedPercent > 100) {
      setWindowError("窗口占比（%）必须是 10–100 的整数")
      return
    }
    setWindowError(null)
    const result = await management.mutate({
      operation: "managed.window",
      model: windowEntry.id,
      windowPercent: parsedPercent,
    })
    if (result !== null) {
      setWindowPercent(String(result.windowPercent ?? windowPercent))
    }
  }



  const cancelPending = () => {
    management.cancel()
    setApiKey("")
  }

  const confirmPending = async () => {
    const operation = management.pendingPreview?.input.operation
    const result = await management.confirm()
    if (result !== null && operation === "primary.custom.save") resetForm()
    if (result !== null) onChanged?.()
  }

  return <Card>
    <CardHeader>
      <CardTitle>Provider 设置</CardTitle>
      <CardDescription>托管 Provider 默认值和Codex 兼容 Provider 共用结构化预览、一次性确认和原子事务；凭据只写入，不回显。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-medium">托管 Provider 默认值</h3><p className="text-xs text-muted-foreground">修改模型目录中的默认模型与思考等级；上下文窗口在下方「模型上下文窗口」按模型名统一设置。</p></div>
          <Badge variant="outline">{settings.managedProviders.length} 个</Badge>
        </div>
        {managed === undefined ? <SettingsEmpty>当前没有已配置的托管 Provider。</SettingsEmpty> : <>
          <FieldGroup>
            <ManagedSelect label="Provider" value={managed.id} options={settings.managedProviders.map((provider) => [provider.id, provider.displayName])} disabled={busy || pending !== null} onChange={(value) => { setManagedProvider(value); const next = settings.managedProviders.find((candidate) => candidate.id === value); if (next !== undefined) { setManagedModel(next.model); setManagedReasoning(next.reasoningEffort) } }} />
            <ManagedSelect label="默认模型" value={managedModel} options={managed.models.map((candidate) => [candidate.id, candidate.displayName])} disabled={busy || pending !== null} onChange={setManagedModel} />
            <ManagedSelect label="思考等级" value={managedReasoning} options={(managedModelEntry?.reasoningEfforts ?? []).map((candidate) => [candidate.effort, candidate.effort])} disabled={busy || pending !== null} onChange={setManagedReasoning} />
          </FieldGroup>
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || managedModelEntry === undefined} onClick={() => void updateManagedDefault()}>保存托管 Provider 默认值</Button>
        </>}
      </section>
      <Separator />
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-medium">模型上下文窗口</h3><p className="text-xs text-muted-foreground">按模型名统一上下文窗口占比（相对模型最大窗口）；同名模型在所有 Provider 共享同一值，自动压缩使用上游默认。</p></div>
          <Badge variant="outline">{settings.modelWindow.length} 个模型</Badge>
        </div>
        {windowEntry === undefined ? <SettingsEmpty>当前没有可设置的受管模型。</SettingsEmpty> : <>
          <FieldGroup>
            <ManagedSelect label="模型" value={windowEntry.id} options={settings.modelWindow.map((candidate) => [candidate.id, candidate.displayName])} disabled={busy || pending !== null} onChange={(value) => { setWindowModel(value); const next = settings.modelWindow.find((candidate) => candidate.id === value); if (next !== undefined) setWindowPercent(String(next.windowPercent ?? 100)) }} />
            <Field orientation="responsive" data-invalid={windowError !== null} data-disabled={busy || pending !== null}><FieldLabel className="text-muted-foreground" htmlFor="provider-window-percent">窗口占比（%）</FieldLabel><FieldContent className="sm:max-w-[220px]"><Input id="provider-window-percent" aria-invalid={windowError !== null} aria-describedby={windowError === null ? undefined : "provider-window-percent-error"} className="w-full sm:w-[160px] sm:self-end" type="number" min={10} max={100} value={windowPercent} disabled={busy || pending !== null} onChange={(event) => { setWindowPercent(event.target.value); setWindowError(null) }} /><FieldError id="provider-window-percent-error" className="sm:text-right">{windowError}</FieldError></FieldContent></Field>
          </FieldGroup>
          <p className="text-xs text-muted-foreground">应用 Provider：{windowEntry.providers.join("、") || "无"} · 上下文窗口 {formatTokens(windowEntry.contextWindow)} / 最大 {formatTokens(windowEntry.maxContextWindow)} tokens</p>
          {windowEntry.conflicts === true ? <Alert><AlertTitle>窗口占比不一致</AlertTitle><AlertDescription>当前不同 Provider 的窗口占比不一致：{Object.entries(windowEntry.perProvider ?? {}).filter(([, value]) => value !== undefined).map(([provider, value]) => `${provider} ${value}%`).join("；") || "部分未设置"}；保存后将以本次输入统一。</AlertDescription></Alert> : null}
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || windowEntry === undefined} onClick={() => void updateWindow()}>保存模型上下文窗口</Button>
        </>}
      </section>
      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">自定义提供商</h3><p className="text-xs text-muted-foreground">Codex 兼容 Provider 使用官方目录；自定义 Responses Provider 使用下方声明的模型与能力。可切换模式保留官方主 Provider；固定模式会修改 Codex 主配置并需要重启全部服务。</p></div>
        {candidates.length === 0 ? <SettingsEmpty>当前没有自定义提供商。</SettingsEmpty> : candidates.map((candidate) => <div key={`${candidate.id}:${candidate.baseUrl}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2"><div className="min-w-0"><div className="font-medium">{candidate.displayName} {"active" in candidate && candidate.active ? <Badge variant="secondary">当前</Badge> : null}</div><div className="truncate text-xs text-muted-foreground">{candidate.id} · {candidate.baseUrl || "地址未返回"}</div></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => edit(candidate)}>编辑</Button><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => void switchProvider(candidate.id)}>切换</Button><Button variant="destructive" size="sm" disabled={busy || pending !== null} onClick={() => void removeProvider(candidate.id)}>删除</Button></div></div>)}
        <ManagedSelect label="提供商类型" value={catalogKind} options={[["official", "Codex 兼容 Provider"], ["custom", "自定义 Responses Provider"]]} disabled={busy || pending !== null || editingId !== null} onChange={(value) => { setCatalogKind(value); setProviderId(value === "custom" ? "rs-" : ""); setModel(""); setCustomModels([]) }} />
        <FieldGroup className="grid gap-3 md:grid-cols-2">
          <Field data-disabled={busy || pending !== null || editingId !== null}><FieldLabel htmlFor="custom-provider-id">{catalogKind === "custom" ? "Provider ID（rs- 开头）" : "Provider ID"}</FieldLabel><Input id="custom-provider-id" placeholder="例如 my-provider" value={providerId} disabled={busy || pending !== null || editingId !== null} onChange={(event) => setProviderId(event.target.value)} /></Field>
          <Field data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-name">显示名称</FieldLabel><Input id="custom-provider-name" placeholder="显示名称" value={providerName} disabled={busy || pending !== null} onChange={(event) => setProviderName(event.target.value)} /></Field>
          <Field className="md:col-span-2" data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-endpoint">Responses 基础地址（HTTPS）</FieldLabel><Input id="custom-provider-endpoint" placeholder="https://example.com/v1" value={baseUrl} disabled={busy || pending !== null} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          <Field data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-model">{catalogKind === "custom" ? "默认模型 ID（须在下方列表中）" : "模型 ID（Codex 官方目录）"}</FieldLabel><Input id="custom-provider-model" placeholder="模型 ID" value={model} disabled={busy || pending !== null} onChange={(event) => setModel(event.target.value)} /></Field>
          <ManagedSelect label="运行模式" value={mode} options={[["switching", "可切换"], ["exclusive", "固定主 Provider"]]} disabled={busy || pending !== null} onChange={(value) => setMode(value as "switching" | "exclusive")} />
          <ManagedSelect label="WebSocket" value={supportsWebsockets} options={[["true", "支持"], ["false", "不支持"]]} disabled={busy || pending !== null} onChange={setSupportsWebsockets} />
          <Field className="md:col-span-2" data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-api-key">API Key</FieldLabel><Input id="custom-provider-api-key" type="password" autoComplete="new-password" placeholder="留空沿用已有凭据" value={apiKey} disabled={busy || pending !== null} onChange={(event) => setApiKey(event.target.value)} /></Field>
        </FieldGroup>
        {catalogKind === "custom" ? <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">请按平台文档声明能力。上游须兼容 Codex 的 Responses 流式请求与工具调用；不推理时发送 none，网页搜索默认关闭。</p>
          {customModels.map((entry, index) => {
            const patch = (changes: Partial<typeof entry>) => setCustomModels(current => current.map((value, position) => position === index ? { ...value, ...changes } : value))
            return <FieldGroup key={index} className="rounded-md border p-3">
              <Field><FieldLabel htmlFor={`responses-model-${index}`}>模型 ID</FieldLabel><Input id={`responses-model-${index}`} value={entry.id} disabled={busy || pending !== null} onChange={event => patch({ id: event.target.value })} /></Field>
              <Field><FieldLabel htmlFor={`responses-name-${index}`}>显示名称</FieldLabel><Input id={`responses-name-${index}`} value={entry.name} disabled={busy || pending !== null} onChange={event => patch({ name: event.target.value })} /></Field>
              {entry.template?.source === "deepseek" ? <Field orientation="horizontal"><Checkbox id={`responses-follow-${index}`} checked={entry.template.followContext} disabled={busy || pending !== null} onCheckedChange={value => patch({template: {...entry.template!, followContext: value === true}})} /><FieldLabel htmlFor={`responses-follow-${index}`}>跟随 DS {entry.template.model} 的上下文</FieldLabel></Field> : null}
              <Field><FieldLabel htmlFor={`responses-context-${index}`}>上下文窗口（Token）</FieldLabel><Input id={`responses-context-${index}`} type="number" min={1024} max={100000000} value={entry.contextWindow || ""} disabled={busy || pending !== null || entry.template?.followContext === true} onChange={event => patch({ contextWindow: Number(event.target.value) })} /></Field>
              <Field><FieldLabel htmlFor={`responses-reasoning-${index}`}>思考等级（逗号分隔；留空表示不支持）</FieldLabel><Input id={`responses-reasoning-${index}`} value={entry.reasoningEfforts.join(",")} placeholder="low,medium,high" disabled={busy || pending !== null} onChange={event => { const values = event.target.value === "" ? [] : event.target.value.split(","); patch({ reasoningEfforts: values, defaultReasoningEffort: values.includes(entry.defaultReasoningEffort ?? "") ? entry.defaultReasoningEffort : values[0] ?? null }) }} /></Field>
              {entry.reasoningEfforts.length > 0 ? <Field><FieldLabel htmlFor={`responses-default-${index}`}>默认思考等级</FieldLabel><Input id={`responses-default-${index}`} value={entry.defaultReasoningEffort ?? ""} disabled={busy || pending !== null} onChange={event => patch({ defaultReasoningEffort: event.target.value })} /></Field> : null}
              <Field orientation="horizontal"><Checkbox id={`responses-images-${index}`} checked={entry.supportsImages} disabled={busy || pending !== null} onCheckedChange={value => patch({ supportsImages: value === true })} /><FieldLabel htmlFor={`responses-images-${index}`}>支持图片输入</FieldLabel></Field>
              <Button variant="outline" disabled={busy || pending !== null} onClick={() => setCustomModels(current => current.filter((_, position) => position !== index))}>移除此模型</Button>
            </FieldGroup>
          })}
          <Button variant="outline" disabled={busy || pending !== null || customModels.length >= 64} onClick={() => setCustomModels(current => [...current, { id: current.length === 0 ? model : "", name: current.length === 0 ? model : "", contextWindow: 0, reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: false }])}>添加模型</Button>
        </div> : null}
        {mode === "exclusive" ? <Field orientation="horizontal" data-disabled={busy || pending !== null}><Checkbox id="custom-provider-remove-base-url" checked={confirmRemoveBaseUrl} disabled={busy || pending !== null} onCheckedChange={(checked) => setConfirmRemoveBaseUrl(checked === true)} /><FieldLabel htmlFor="custom-provider-remove-base-url" className="text-xs text-muted-foreground">确认固定模式需要时移除顶层 openai_base_url</FieldLabel></Field> : null}
        <div className="flex flex-wrap gap-2"><Button disabled={busy || pending !== null || providerId.trim() === "" || providerName.trim() === "" || baseUrl.trim() === "" || model.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void saveCustom()}>{editingId === null ? "新增 Provider" : "保存 Provider"}</Button>{editingId !== null ? <Button variant="outline" disabled={busy || pending !== null} onClick={resetForm}>取消编辑</Button> : null}<Button variant="outline" disabled={busy || pending !== null} onClick={() => void switchProvider("openai")}>切回官方 OpenAI</Button></div>
      </section>
      {pending !== null ? <ProviderSettingsConfirmationDialog pending={pending.preview} saving={busy} onConfirm={() => void confirmPending()} onCancel={cancelPending} /> : null}
      {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>
}

function ProviderSettingsConfirmationDialog({
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
  if (pending.provider?.models !== undefined) for (const model of pending.provider.models) lines.push(`模型：${model.name}（${model.id}），上下文 ${model.contextWindow} Token，图片 ${model.supportsImages ? "支持" : "不支持"}，思考等级 ${model.reasoningEfforts.join("/") || "不支持"}，默认 ${model.defaultReasoningEffort ?? "none"}${model.template ? `，模板 ${model.template.source}/${model.template.model}，上下文${model.template.followContext ? "跟随" : "独立"}` : ""}`)
  if (pending.target !== undefined) lines.push(`目标：${pending.target.displayName}（${pending.target.id}）`)
  if (pending.model !== undefined) lines.push(`模型：${pending.model.displayName}（${pending.model.id}）`)
  if (pending.providers !== undefined && pending.providers.length > 0) lines.push(`应用 Provider：${pending.providers.join("、")}`)
  if (pending.overridden !== undefined && pending.overridden.length > 0) lines.push(`将覆盖：${pending.overridden.map((entry) => `${entry.provider}（原 ${entry.previousPercent}%）`).join("、")}`)
  if (pending.conflicts === true) lines.push(`提示：该模型在不同 Provider 的窗口占比不一致，保存后统一为本次输入。`)
  if (pending.windowConflict === true) lines.push(`提示：该模型在不同 Provider 的最大窗口不一致，无法统一窗口设置。`)
  if (pending.reasoningEffort !== undefined) lines.push(`思考等级：${pending.reasoningEffort}`)
  if (pending.windowPercent !== undefined) lines.push(`上下文窗口：${pending.windowPercent}%`)
  if (pending.credential?.action !== undefined) lines.push(`凭据：${pending.credential.action === "replace" ? "写入新 API Key" : "沿用已有 API Key"}`)
  return <ManagementConfirmationDialog open saving={saving} title="确认 Provider 配置修改" description="确认后写入对应配置，不会自动执行生效目标。" confirmVariant={pending.operation === "remove" ? "destructive" : "default"} onConfirm={onConfirm} onCancel={onCancel}>
    <p className="whitespace-pre-line">{lines.join("\n")}</p>
    <p className="text-muted-foreground">生效目标：{pending.activation}</p>
  </ManagementConfirmationDialog>
}
