import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import type { ApiProviderManagementController } from "@/lib/settings-management"
import type { ManagementApiProvider, ManagementApiProviderPreview } from "@/lib/types"

export function ApiProviderManagement({
  management,
  onChanged,
}: {
  management: ApiProviderManagementController
  onChanged?: () => void
}) {
  const { providers, busy, error, clearError } = management
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const pending = management.pendingPreview
  const save = async () => {
    await management.mutate({
      operation: "save",
      provider: {
        id: id.trim(),
        name: name.trim(),
        endpoint: endpoint.trim(),
        ...(apiKey.trim() === "" ? {} : { apiKey }),
      },
    })
  }

  const confirmPending = async () => {
    const input = pending?.input
    const result = await management.confirm()
    if (result !== null) {
      if (input?.operation === "delete") {
        if (input.id === editingId) {
          setId("")
          setName("")
          setEndpoint("")
          setApiKey("")
          setEditingId(null)
        }
      } else {
        setApiKey("")
        setEditingId(null)
      }
      onChanged?.()
    }
  }

  const deleteProvider = async (providerId: string) => {
    await management.mutate({ operation: "delete", id: providerId })
  }

  const edit = (provider: Pick<ManagementApiProvider, "id" | "name" | "endpoint">) => {
    setId(provider.id)
    setName(provider.name)
    setEndpoint(provider.endpoint)
    setApiKey("")
    setEditingId(provider.id)
    clearError()
  }

  const cancelEdit = () => {
    setId("")
    setName("")
    setEndpoint("")
    setApiKey("")
    setEditingId(null)
    clearError()
  }

  return <Card>
    <CardHeader><CardTitle>直接 API Provider</CardTitle><CardDescription>新增、编辑和删除使用结构化配置；API Key 只写入私有凭据目录，不会回显。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3 text-sm">
      {providers.loading ? <p className="text-muted-foreground">正在读取 Provider…</p> : null}
      {providers.error !== null ? <div className="flex items-center justify-between gap-3 text-destructive"><span>{providers.error}</span><Button variant="outline" size="sm" onClick={providers.refetch}>重试</Button></div> : null}
      {providers.error === null ? providers.data?.providers.map((provider) => <div key={provider.id} className="flex items-center justify-between gap-3 rounded-md border p-2"><div className="min-w-0"><div className="font-medium">{provider.name} <span className="text-muted-foreground">({provider.id})</span></div><div className="truncate text-xs text-muted-foreground">{provider.endpoint} · API Key {provider.hasApiKey ? "已配置" : "未配置"}</div></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => edit(provider)}>编辑</Button><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => void deleteProvider(provider.id)}>删除</Button></div></div>) : null}
      <div className="grid gap-2 md:grid-cols-2"><Input placeholder="Provider ID" value={id} disabled={editingId !== null} onChange={(event) => setId(event.target.value)} /><Input placeholder="显示名称" value={name} onChange={(event) => setName(event.target.value)} /><Input className="md:col-span-2" placeholder="Responses Endpoint (HTTPS)" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /><Input className="md:col-span-2" type="password" autoComplete="new-password" placeholder="API Key（仅写入，不读取）" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
      <div className="flex gap-2"><Button disabled={busy || pending !== null || id.trim() === "" || name.trim() === "" || endpoint.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void save()}>{editingId === null ? "新增 Provider" : "保存修改"}</Button>{editingId !== null ? <Button variant="outline" disabled={busy || pending !== null} onClick={cancelEdit}>取消编辑</Button> : null}</div>
      {error !== null ? <p className="text-destructive" role="status">{error}</p> : null}
      {pending !== null ? <ManagementConfirmationDialog open saving={busy} title={pending.input.operation === "delete" ? "确认删除 Provider" : "确认保存 Provider"} description="确认后写入直接 API Provider 配置，不会自动执行生效目标。" onConfirm={() => void confirmPending()} onCancel={management.cancel}>
        <p className="whitespace-pre-line">{formatProviderPreview(pending.preview, pending.input.operation === "delete" ? `删除 Provider ${pending.input.id}` : "保存 Provider")}</p>
      </ManagementConfirmationDialog> : null}
    </CardContent>
  </Card>
}

function formatProviderPreview(preview: ManagementApiProviderPreview, fallback: string): string {
  if (preview === null || typeof preview !== "object" || preview.provider === null || typeof preview.provider !== "object") {
    return `确认：${fallback}？`
  }
  const provider = preview.provider
  const lines = [
    `操作：${preview.operation || fallback}`,
    `Provider：${provider.name || provider.id}`,
    provider.apiKeyChange === true ? "API Key：将写入私有凭据目录" : provider.apiKeyChange === false ? "API Key：沿用已有凭据" : null,
    formatActivation(preview.activation),
  ].filter((line): line is string => line !== null)
  return lines.join("\n")
}

function formatActivation(activation: ManagementApiProviderPreview["activation"]): string {
  const commands = activation.commands.slice(0, 3)
  if (commands.length > 0) return `生效：${commands.join("；")}`
  return `生效目标：${activation.target}`
}
