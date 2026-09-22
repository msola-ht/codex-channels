import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import type { AccountSettingsController } from "@/lib/settings-management"

export function AccountSettingsManagement({ management, onChanged }: { management: AccountSettingsController; onChanged?: () => void }) {
  const settings = management.settings
  if (management.loading && settings === null) return <LoadingSettingsCard title="账户设置" />
  if (settings === null) return <SettingsError message={management.error ?? "账户设置暂不可用"} retry={management.refetch} />
  return <AccountSettingsCard management={management} settings={settings} onChanged={onChanged} />
}

function AccountSettingsCard({ management, settings, onChanged }: { management: AccountSettingsController; settings: NonNullable<AccountSettingsController["settings"]>; onChanged?: () => void }) {
  const [accountId, setAccountId] = useState("")
  const [contact, setContact] = useState("")
  const [accountMode, setAccountMode] = useState<"switching" | "exclusive">("switching")
  const [accountKey, setAccountKey] = useState("")
  const [accountReconfigure, setAccountReconfigure] = useState(false)
  const [deepseekMode, setDeepseekMode] = useState<"switching" | "exclusive">("switching")
  const [deepseekKey, setDeepseekKey] = useState("")
  const [dsAccountId, setDsAccountId] = useState("")
  const [dsReconfigure, setDsReconfigure] = useState(false)
  const pending = management.pendingPreview

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
      accountId: dsAccountId.trim(),
      reconfigure: dsReconfigure,
    })
  }
  const confirmPending = async () => {
    const result = await management.confirm()
    if (result !== null && pending?.input.operation === "opencode.account.configure") {
      setAccountKey("")
      setAccountReconfigure(false)
    }
    if (result !== null && pending?.input.operation === "deepseek.configure") {
      setDeepseekKey("")
      setDsReconfigure(false)
    }
    if (result !== null) onChanged?.()
  }
  const cancelPending = () => {
    management.cancel()
    setAccountKey("")
    setDeepseekKey("")
  }
  const editAccount = (account: typeof settings.opencodeGo.accounts[number]) => {
    setAccountId(account.id)
    setContact(account.email ?? account.phone ?? "")
    setAccountMode(account.mode ?? "switching")
    setAccountReconfigure(true)
    setAccountKey("")
  }
  const disabled = management.busy || management.loading || pending !== null

  return <Card>
    <CardHeader>
      <CardTitle>账户与授权配置</CardTitle>
      <CardDescription>OpenCode Go 多账户和 DeepSeek 配置复用现有原子事务；API Key 只写入，不会回显或进入结果。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6 text-sm">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">OpenCode Go 多账户</h3><p className="text-xs text-muted-foreground">联系方式只用于账户展示和指标身份；切换默认账户不影响共享第三方子代理，请通过共享子代理设置显式选择。</p></div><Badge variant="outline">{settings.opencodeGo.accounts.length} 个</Badge></div>
        {settings.opencodeGo.accounts.length === 0 ? <SettingsEmpty>尚未配置 OpenCode Go 账户。</SettingsEmpty> : settings.opencodeGo.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2"><div><div className="font-medium">{account.displayName} {account.default ? <Badge variant="secondary">默认</Badge> : null}</div><div className="text-xs text-muted-foreground">{account.email ?? account.phone ?? account.id}</div></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={() => editAccount(account)}>编辑</Button><Button variant="outline" size="sm" disabled={disabled || account.default} onClick={() => void management.mutate({ operation: "opencode.account.default", accountId: account.id })}>设为默认</Button><Button variant="destructive" size="sm" disabled={disabled} onClick={() => void management.mutate({ operation: "opencode.account.stop", accountId: account.id })}>停止</Button><Button variant="destructive" size="sm" disabled={disabled} onClick={() => void management.mutate({ operation: "opencode.account.remove", accountId: account.id })}>删除</Button></div></div>)}
        <FieldGroup className="grid gap-3 md:grid-cols-2"><Field data-disabled={disabled || accountReconfigure}><FieldLabel htmlFor="ocg-account-id">账户 ID</FieldLabel><Input id="ocg-account-id" placeholder="小写字母、数字、-、_" value={accountId} disabled={disabled || accountReconfigure} onChange={(event) => setAccountId(event.target.value)} /></Field><Field data-disabled={disabled}><FieldLabel htmlFor="ocg-account-contact">邮箱或手机号</FieldLabel><Input id="ocg-account-contact" placeholder="邮箱或手机号（二选一）" value={contact} disabled={disabled} onChange={(event) => setContact(event.target.value)} /></Field><ManagedSelect label="运行模式" value={accountMode} options={[["switching", "可切换"], ["exclusive", "固定主 Provider"]]} disabled={disabled} onChange={(value) => setAccountMode(value as "switching" | "exclusive")} /><Field data-disabled={disabled}><FieldLabel htmlFor="ocg-account-api-key">API Key</FieldLabel><Input id="ocg-account-api-key" type="password" autoComplete="new-password" placeholder="仅写入，不会回显" value={accountKey} disabled={disabled} onChange={(event) => setAccountKey(event.target.value)} /></Field></FieldGroup>
        <div className="flex flex-wrap gap-2"><Button disabled={disabled || accountId.trim() === "" || contact.trim() === "" || accountKey.trim() === ""} onClick={() => void configureAccount()}>{accountReconfigure ? "重新配置账户" : "新增账户"}</Button>{accountReconfigure ? <Button variant="outline" disabled={disabled} onClick={() => { setAccountId(""); setContact(""); setAccountKey(""); setAccountReconfigure(false) }}>取消编辑</Button> : null}</div>
      </section>
      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">DeepSeek 多账户</h3><p className="text-xs text-muted-foreground">账户分别保存 Key、模型选择与统计，共用 DS 官方模型目录。</p></div>
        {settings.deepseek.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center justify-between gap-2"><div>{account.id} {account.default ? <Badge variant="outline">默认</Badge> : null}<p className="text-xs text-muted-foreground">{account.model} · {account.mode}</p></div><div className="flex gap-2"><Button variant="outline" disabled={disabled} onClick={() => { setDsAccountId(account.id); setDeepseekMode(account.mode ?? "switching"); setDsReconfigure(true); setDeepseekKey("") }}>重新配置</Button><Button variant="outline" disabled={disabled || account.default} onClick={() => void management.mutate({ operation: "deepseek.default", accountId: account.id })}>设为默认</Button><Button variant="destructive" disabled={disabled} onClick={() => void management.mutate({ operation: "deepseek.remove", accountId: account.id })}>删除</Button></div></div>)}
        {settings.deepseek.migrationRequired ? <Alert><AlertDescription>填写账户 ID 后迁移现有 DS 配置。原 Key、模型设置与历史统计保留，旧会话不再接续。</AlertDescription></Alert> : null}
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field data-disabled={disabled || dsReconfigure}><FieldLabel htmlFor="ds-account-id">账户 ID</FieldLabel><Input id="ds-account-id" value={dsAccountId} disabled={disabled || dsReconfigure} onChange={(event) => setDsAccountId(event.target.value)} placeholder="小写字母、数字、-、_" /></Field>
          {!settings.deepseek.migrationRequired ? <><ManagedSelect label="运行模式" value={deepseekMode} options={[["switching", "可切换"], ["exclusive", "固定主 Provider"]]} disabled={disabled} onChange={(value) => setDeepseekMode(value as "switching" | "exclusive")} /><Field data-disabled={disabled}><FieldLabel htmlFor="deepseek-api-key">DeepSeek API Key</FieldLabel><Input id="deepseek-api-key" type="password" autoComplete="new-password" placeholder="仅写入，不会回显" value={deepseekKey} disabled={disabled} onChange={(event) => setDeepseekKey(event.target.value)} /></Field></> : null}
        </FieldGroup>
        <div className="flex gap-2">{settings.deepseek.migrationRequired ? <Button disabled={disabled || dsAccountId.trim() === ""} onClick={() => void management.mutate({ operation: "deepseek.migrate", accountId: dsAccountId.trim() })}>迁移旧账户</Button> : <Button disabled={disabled || dsAccountId.trim() === "" || deepseekKey.trim() === ""} onClick={() => void configureDeepseek()}>{dsReconfigure ? "重新配置账户" : "新增账户"}</Button>}{dsReconfigure ? <Button variant="outline" disabled={disabled} onClick={() => { setDsAccountId(""); setDsReconfigure(false); setDeepseekKey("") }}>取消编辑</Button> : null}</div>
      </section>
      {pending !== null ? <AccountSettingsConfirmationDialog pending={pending} saving={management.busy} onConfirm={() => void confirmPending()} onCancel={cancelPending} /> : null}
      {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>
}

export function AccountSettingsConfirmationDialog({
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
  if (account?.id !== undefined) lines.push(`账户：${account.displayName ?? account.email ?? account.phone ?? account.id}（${account.id}）`)
  if (provider?.name !== undefined) lines.push(`Provider：${provider.name}（${provider.id ?? "未知"}）`)
  if (preview.mode !== undefined) lines.push(`模式：${preview.mode}`)
  if (preview.model !== undefined) lines.push(`模型：${preview.model}`)
  if (preview.status !== undefined) lines.push(`状态：${preview.status}`)
  if (preview.effects !== undefined) {
    const effects = Object.entries(preview.effects).filter(([, value]) => value !== false && value !== null && value !== undefined).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
    if (effects.length > 0) lines.push(`影响：${effects.join("；")}`)
  }
  const destructive = pending.input.operation === "opencode.account.stop"
    || pending.input.operation === "opencode.account.remove"
    || pending.input.operation === "deepseek.remove"
  return <ManagementConfirmationDialog open saving={saving} title="确认账户配置修改" description="确认后写入对应配置，不会自动执行生效目标。" confirmVariant={destructive ? "destructive" : "default"} confirmLabel={pending.input.operation === "opencode.account.remove" ? "确认删除" : "确认写入"} onConfirm={onConfirm} onCancel={onCancel}>
    {pending.input.operation === "opencode.account.remove" ? <p>删除本地账户配置后，该账户历史 Thread 将不可恢复；此操作不会取消或续订官方订阅。</p> : null}
    <p className="whitespace-pre-line">{lines.join("\n")}</p>
    <p className="text-muted-foreground">生效目标：{preview.activation ?? "按操作结果"}</p>
  </ManagementConfirmationDialog>
}
