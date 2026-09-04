import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApiProviderManagement } from "@/hooks/use-api-provider-management"
import type { ManagementApiProvider } from "@/lib/types"

export function ApiProviderManagement() {
  const management = useApiProviderManagement()
  const { providers, busy, error, clearError, save: saveProvider, remove: removeProvider } = management
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const save = async () => {
    const succeeded = await saveProvider({
      operation: "save",
      provider: {
        id: id.trim(),
        name: name.trim(),
        endpoint: endpoint.trim(),
        ...(apiKey.trim() === "" ? {} : { apiKey }),
      },
    })
    if (succeeded) {
      setApiKey("")
      setEditingId(null)
    }
  }

  const deleteProvider = async (providerId: string) => {
    const succeeded = await removeProvider(providerId)
    if (succeeded) {
      if (editingId === providerId) {
        setId("")
        setName("")
        setEndpoint("")
        setApiKey("")
        setEditingId(null)
      }
    }
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
      {!providers.loading && providers.error === null ? providers.data?.providers.map((provider) => <div key={provider.id} className="flex items-center justify-between gap-3 rounded-md border p-2"><div className="min-w-0"><div className="font-medium">{provider.name} <span className="text-muted-foreground">({provider.id})</span></div><div className="truncate text-xs text-muted-foreground">{provider.endpoint} · API Key {provider.hasApiKey ? "已配置" : "未配置"}</div></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => edit(provider)}>编辑</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void deleteProvider(provider.id)}>删除</Button></div></div>) : null}
      <div className="grid gap-2 md:grid-cols-2"><Input placeholder="Provider ID" value={id} disabled={editingId !== null} onChange={(event) => setId(event.target.value)} /><Input placeholder="显示名称" value={name} onChange={(event) => setName(event.target.value)} /><Input className="md:col-span-2" placeholder="Responses Endpoint (HTTPS)" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /><Input className="md:col-span-2" type="password" autoComplete="new-password" placeholder="API Key（仅写入，不读取）" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
      <div className="flex gap-2"><Button disabled={busy || id.trim() === "" || name.trim() === "" || endpoint.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void save()}>{editingId === null ? "新增 Provider" : "保存修改"}</Button>{editingId !== null ? <Button variant="outline" disabled={busy} onClick={cancelEdit}>取消编辑</Button> : null}</div>
      {error !== null ? <p className="text-destructive" role="status">{error}</p> : null}
    </CardContent>
  </Card>
}
