import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApi } from "@/hooks/use-api"
import { applyManagementApiProvider, fetchManagementApiProviders, previewManagementApiProvider } from "@/lib/api"

export function ApiProviderManagement() {
  const providers = useApi(fetchManagementApiProviders, [])
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const input = {
        operation: "save",
        provider: {
          id: id.trim(),
          name: name.trim(),
          endpoint: endpoint.trim(),
          ...(apiKey.trim() === "" ? {} : { apiKey }),
        },
      }
      const preview = await previewManagementApiProvider(input)
      if (!window.confirm(formatProviderPreview(preview.preview, "保存 Provider"))) return
      await applyManagementApiProvider(input, preview.confirmationToken)
      setApiKey("")
      setEditingId(null)
      providers.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (providerId: string) => {
    setBusy(true)
    setError(null)
    try {
      const input = { operation: "delete", id: providerId }
      const preview = await previewManagementApiProvider(input)
      if (!window.confirm(formatProviderPreview(preview.preview, `删除 Provider ${providerId}`))) return
      await applyManagementApiProvider(input, preview.confirmationToken)
      if (editingId === providerId) {
        setId("")
        setName("")
        setEndpoint("")
        setApiKey("")
        setEditingId(null)
      }
      providers.refetch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const edit = (provider: { id: string; name: string; endpoint: string }) => {
    setId(provider.id)
    setName(provider.name)
    setEndpoint(provider.endpoint)
    setApiKey("")
    setEditingId(provider.id)
    setError(null)
  }

  const cancelEdit = () => {
    setId("")
    setName("")
    setEndpoint("")
    setApiKey("")
    setEditingId(null)
    setError(null)
  }

  return <Card>
    <CardHeader><CardTitle>直接 API Provider</CardTitle><CardDescription>新增、编辑和删除使用结构化配置；API Key 只写入私有凭据目录，不会回显。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3 text-sm">
      {providers.loading ? <p className="text-muted-foreground">正在读取 Provider…</p> : null}
      {providers.error !== null ? <div className="flex items-center justify-between gap-3 text-destructive"><span>{providers.error}</span><Button variant="outline" size="sm" onClick={providers.refetch}>重试</Button></div> : null}
      {!providers.loading && providers.error === null ? providers.data?.providers.map((provider) => <div key={provider.id} className="flex items-center justify-between gap-3 rounded-md border p-2"><div className="min-w-0"><div className="font-medium">{provider.name} <span className="text-muted-foreground">({provider.id})</span></div><div className="truncate text-xs text-muted-foreground">{provider.endpoint} · API Key {provider.hasApiKey ? "已配置" : "未配置"}</div></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => edit(provider)}>编辑</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void remove(provider.id)}>删除</Button></div></div>) : null}
      <div className="grid gap-2 md:grid-cols-2"><Input placeholder="Provider ID" value={id} disabled={editingId !== null} onChange={(event) => setId(event.target.value)} /><Input placeholder="显示名称" value={name} onChange={(event) => setName(event.target.value)} /><Input className="md:col-span-2" placeholder="Responses Endpoint (HTTPS)" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /><Input className="md:col-span-2" type="password" autoComplete="new-password" placeholder="API Key（仅写入，不读取）" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
      <div className="flex gap-2"><Button disabled={busy || id.trim() === "" || name.trim() === "" || endpoint.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void save()}>{editingId === null ? "新增 Provider" : "保存修改"}</Button>{editingId !== null ? <Button variant="outline" disabled={busy} onClick={cancelEdit}>取消编辑</Button> : null}</div>
      {error !== null ? <p className="text-destructive" role="status">{error}</p> : null}
    </CardContent>
  </Card>
}

function formatProviderPreview(preview: unknown, fallback: string): string {
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return `确认：${fallback}？`
  const value = preview as {
    operation?: unknown
    provider?: { id?: unknown; name?: unknown; apiKeyChange?: unknown }
    activation?: { status?: unknown; target?: unknown; commands?: unknown }
  }
  const provider = value.provider
  const lines = [
    `操作：${textValue(value.operation) ?? fallback}`,
    `Provider：${textValue(provider?.name) ?? textValue(provider?.id) ?? "未指定"}`,
    provider?.apiKeyChange === true ? "API Key：将写入私有凭据目录" : provider?.apiKeyChange === false ? "API Key：沿用已有凭据" : null,
    formatActivation(value.activation),
  ].filter((line): line is string => line !== null)
  return `${lines.join("\n")}\n\n确认执行？`
}

function formatActivation(activation: { status?: unknown; target?: unknown; commands?: unknown } | undefined): string {
  const commands = Array.isArray(activation?.commands)
    ? activation.commands.filter((command): command is string => typeof command === "string").slice(0, 3)
    : []
  if (commands.length > 0) return `生效：${commands.join("；")}`
  const target = textValue(activation?.target)
  return target === null ? "生效：请按页面提示检查 Gateway 状态" : `生效目标：${target}`
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 120) : null
}
