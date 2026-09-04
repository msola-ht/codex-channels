import { useEffect, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ManagedSelect } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { AccountSettingsController } from "@/lib/settings-management"

export function AccountSettingsManagement({ management }: { management: AccountSettingsController }) {
  const settings = management.settings
  if (management.loading) return <LoadingSettingsCard title="账户设置" />
  if (settings === null) return <SettingsError message={management.error ?? "账户设置暂不可用"} retry={management.refetch} />
  return <AccountSettingsCard management={management} settings={settings} />
}

function AccountSettingsCard({ management, settings }: { management: AccountSettingsController; settings: NonNullable<AccountSettingsController["settings"]> }) {
  const [accountId, setAccountId] = useState("")
  const [contact, setContact] = useState("")
  const [accountMode, setAccountMode] = useState<"switching" | "exclusive">("switching")
  const [accountKey, setAccountKey] = useState("")
  const [accountReconfigure, setAccountReconfigure] = useState(false)
  const [deepseekMode, setDeepseekMode] = useState<"switching" | "exclusive">(settings.deepseek.mode ?? "switching")
  const [deepseekKey, setDeepseekKey] = useState("")
  const [autoCompactPercent, setAutoCompactPercent] = useState("60")
  const pending = management.pendingPreview

  useEffect(() => {
    if (pending !== null) return
    setDeepseekMode(settings.deepseek.mode ?? "switching")
  }, [pending, settings.deepseek.mode])

  const configureAccount = async () => {
    await management.mutate({
      operation: "opencode.account.configure",
      accountId: accountId.trim(),
      contact: contact.trim(),
      mode: accountMode,
      reconfigure: accountReconfigure,
      apiKey: accountKey,
    })
  }
  const configureDeepseek = async () => {
    await management.mutate({
      operation: "deepseek.configure",
      mode: deepseekMode,
      apiKey: deepseekKey,
      autoCompactPercent: Number(autoCompactPercent),
    })
  }
  const confirmPending = async () => {
    const result = await management.confirm()
    if (result !== null && pending?.input.operation === "opencode.account.configure") {
      setAccountKey("")
      setAccountReconfigure(false)
    }
    if (result !== null && pending?.input.operation === "deepseek.configure") setDeepseekKey("")
  }
  const editAccount = (account: typeof settings.opencodeGo.accounts[number]) => {
    setAccountId(account.id)
    setContact(account.email ?? account.phone ?? "")
    setAccountMode(account.mode ?? "switching")
    setAccountReconfigure(true)
    setAccountKey("")
  }
  const disabled = management.busy || pending !== null

  return <Card>
    <CardHeader>
      <CardTitle>账户与授权配置</CardTitle>
      <CardDescription>OpenCode Go 多账户和 DeepSeek 配置复用现有原子事务；API Key 只写入，不会回显或进入结果。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">OpenCode Go 多账户</h3><p className="text-xs text-muted-foreground">联系方式只用于账户展示和指标身份；切换默认账户会同步共享第三方子代理。</p></div><Badge variant="outline">{settings.opencodeGo.accounts.length} 个</Badge></div>
        {settings.opencodeGo.accounts.length === 0 ? <p className="text-muted-foreground">尚未配置 OpenCode Go 账户。</p> : settings.opencodeGo.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2"><div><div className="font-medium">{account.displayName} {account.default ? <Badge variant="secondary">默认</Badge> : null}</div><div className="text-xs text-muted-foreground">{account.email ?? account.phone ?? account.id}</div></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={() => editAccount(account)}>编辑</Button><Button variant="outline" size="sm" disabled={disabled || account.default} onClick={() => void management.mutate({ operation: "opencode.account.default", accountId: account.id })}>设为默认</Button><Button variant="outline" size="sm" disabled={disabled} onClick={() => void management.mutate({ operation: "opencode.account.stop", accountId: account.id })}>停止</Button><Button variant="outline" size="sm" disabled={disabled} onClick={() => void management.mutate({ operation: "opencode.account.remove", accountId: account.id })}>删除</Button></div></div>)}
        <div className="grid gap-2 md:grid-cols-2"><Input placeholder="账户 ID（小写字母、数字、-、_）" value={accountId} disabled={disabled || accountReconfigure} onChange={(event) => setAccountId(event.target.value)} /><Input placeholder="邮箱或手机号（二选一）" value={contact} disabled={disabled} onChange={(event) => setContact(event.target.value)} /><ManagedSelect label="运行模式" value={accountMode} options={[["switching", "可切换"], ["exclusive", "固定主 Provider"]]} disabled={disabled} onChange={(value) => setAccountMode(value as "switching" | "exclusive")} /><Input type="password" autoComplete="new-password" placeholder="API Key（仅写入）" value={accountKey} disabled={disabled} onChange={(event) => setAccountKey(event.target.value)} /></div>
        <div className="flex gap-2"><Button disabled={disabled || accountId.trim() === "" || contact.trim() === "" || accountKey.trim() === ""} onClick={() => void configureAccount()}>{accountReconfigure ? "重新配置账户" : "新增账户"}</Button>{accountReconfigure ? <Button variant="outline" disabled={disabled} onClick={() => { setAccountId(""); setContact(""); setAccountKey(""); setAccountReconfigure(false) }}>取消编辑</Button> : null}</div>
      </section>
      <section className="flex flex-col gap-3 border-t pt-5">
        <div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">DeepSeek</h3><p className="text-xs text-muted-foreground">配置官方模型目录和独立 Profile；固定模式会修改并备份 Codex 主配置。</p></div><Badge variant="outline">{settings.deepseek.configured ? `已配置 · ${settings.deepseek.mode ?? "未知模式"}` : "未配置"}</Badge></div>
        <div className="grid gap-2 md:grid-cols-3"><ManagedSelect label="运行模式" value={deepseekMode} options={[["switching", "可切换"], ["exclusive", "固定主 Provider"]]} disabled={disabled} onChange={(value) => setDeepseekMode(value as "switching" | "exclusive")} /><Input type="number" min={10} max={90} value={autoCompactPercent} disabled={disabled} onChange={(event) => setAutoCompactPercent(event.target.value)} placeholder="自动压缩百分比" /><Input type="password" autoComplete="new-password" placeholder="DeepSeek API Key（仅写入）" value={deepseekKey} disabled={disabled} onChange={(event) => setDeepseekKey(event.target.value)} /></div>
        <div className="flex gap-2"><Button disabled={disabled || deepseekKey.trim() === ""} onClick={() => void configureDeepseek()}>{settings.deepseek.configured ? "重新配置 DeepSeek" : "配置 DeepSeek"}</Button>{settings.deepseek.restoreAvailable ? <Button variant="outline" disabled={disabled} onClick={() => void management.mutate({ operation: "deepseek.restore" })}>恢复安装前配置</Button> : null}</div>
      </section>
      {pending !== null ? <AccountSettingsConfirmationCard pending={pending} saving={management.busy} onConfirm={() => void confirmPending()} onCancel={management.cancel} /> : null}
      {management.actionError !== null ? <p className="text-destructive" role="status">{management.actionError}</p> : null}
    </CardContent>
  </Card>
}

function AccountSettingsConfirmationCard({
  pending,
  saving,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<AccountSettingsController["pendingPreview"]>
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const preview = pending.preview
  const account = preview.account
  const provider = preview.provider
  const lines = [`操作：${preview.operation}`]
  if (account?.displayName !== undefined) lines.push(`账户：${account.displayName}（${account.id ?? "未知"}）`)
  if (provider?.name !== undefined) lines.push(`Provider：${provider.name}（${provider.id ?? "未知"}）`)
  if (preview.mode !== undefined) lines.push(`模式：${preview.mode}`)
  if (preview.model !== undefined) lines.push(`模型：${preview.model}`)
  if (preview.status !== undefined) lines.push(`状态：${preview.status}`)
  if (preview.effects !== undefined) {
    const effects = Object.entries(preview.effects).filter(([, value]) => value !== false && value !== null && value !== undefined).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
    if (effects.length > 0) lines.push(`影响：${effects.join("；")}`)
  }
  return <Card className="border-primary/40"><CardHeader><CardTitle className="text-base">确认账户配置修改</CardTitle><CardDescription>确认后写入对应配置，不会自动执行生效目标。</CardDescription></CardHeader><CardContent className="text-sm"><p className="whitespace-pre-line">{lines.join("\n")}</p><p className="mt-1 text-muted-foreground">生效目标：{preview.activation ?? "按操作结果"}</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={saving} onClick={onConfirm}>确认写入</Button><Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>取消</Button></div></CardContent></Card>
}
