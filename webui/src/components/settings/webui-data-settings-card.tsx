import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"

const proxyFields = [
  ["http_proxy", "HTTP_PROXY", "http://127.0.0.1:7890"],
  ["https_proxy", "HTTPS_PROXY", "http://127.0.0.1:7890"],
  ["all_proxy", "ALL_PROXY", "socks5://127.0.0.1:7890"],
  ["no_proxy", "NO_PROXY", "127.0.0.1,localhost"],
] as const

export function WebuiDataSettingsCard({ management }: { management: GatewaySettingsController }) {
  const settings = management.managedSettings
  const [retentionDays, setRetentionDays] = useState("")
  const [maxRows, setMaxRows] = useState("")
  const [port, setPort] = useState("")
  const [webuiToken, setWebuiToken] = useState("")
  const [proxyValues, setProxyValues] = useState<Record<string, string>>({})
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (settings === null || management.pendingSetting !== null) return
    setRetentionDays(String(settings.metrics.storage.retentionDays))
    setMaxRows(String(settings.metrics.storage.maxRows))
    setPort(String(settings.webui.port))
    setWebuiToken("")
    setProxyValues({})
    setLocalError(null)
  }, [management.pendingSetting, settings])

  if (settings === null) return null
  const disabled = management.saving || management.pendingSetting !== null

  const saveMetrics = () => {
    const days = Number(retentionDays)
    const rows = Number(maxRows)
    if (!Number.isInteger(days) || days < 1 || days > 3_650) {
      setLocalError("指标保留天数必须是 1–3650 的整数")
      return
    }
    if (!Number.isInteger(rows) || rows < 1_000 || rows > 10_000_000) {
      setLocalError("指标最大行数必须是 1,000–10,000,000 的整数")
      return
    }
    setLocalError(null)
    void management.previewSetting("metrics.storage", { retentionDays: days, maxRows: rows }, "指标存储")
  }

  const savePort = () => {
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      setLocalError("WebUI 端口必须是 1–65535 的整数")
      return
    }
    setLocalError(null)
    void management.previewSetting("webui.port", parsed, "WebUI 端口")
  }

  const setProxy = (field: string, label: string) => {
    const value = proxyValues[field]?.trim() ?? ""
    if (value === "") {
      setLocalError(label + " 不能为空")
      return
    }
    setLocalError(null)
    void management.previewSetting("network.proxy", { field, action: "set", value }, label)
  }

  return <Card>
    <CardHeader><CardTitle>WebUI、代理与指标存储</CardTitle><CardDescription>完整管理本地 WebUI、显式代理和指标保留策略；代理和令牌现有值不会回显。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5 text-sm">
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">指标存储</h3><p className="text-xs text-muted-foreground">达到保留天数或最大行数任一上限后删除最旧记录。</p></div>
        <FieldGroup className="grid gap-3 md:grid-cols-2">
          <Field data-disabled={disabled}><FieldLabel htmlFor="metrics-retention-days">保留天数</FieldLabel><Input id="metrics-retention-days" type="number" min={1} max={3650} value={retentionDays} disabled={disabled} onChange={(event) => setRetentionDays(event.target.value)} /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor="metrics-max-rows">最大行数</FieldLabel><Input id="metrics-max-rows" type="number" min={1000} max={10000000} value={maxRows} disabled={disabled} onChange={(event) => setMaxRows(event.target.value)} /></Field>
        </FieldGroup>
        <Button className="self-start" variant="outline" disabled={disabled} onClick={saveMetrics}>保存指标存储</Button>
      </section>

      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">WebUI 服务</h3><p className="text-xs text-muted-foreground">监听地址、端口或令牌变化后需要重启 WebUI。</p></div>
        <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <ManagedSelect label="监听地址" value={settings.webui.host} options={[["127.0.0.1", "127.0.0.1"], ["::1", "::1"], ["0.0.0.0", "0.0.0.0"]]} disabled={disabled} onChange={(value) => void management.previewSetting("webui.host", value, "WebUI 监听地址")} />
          <Field orientation="responsive" data-disabled={disabled}><FieldLabel className="text-muted-foreground" htmlFor="webui-port">监听端口</FieldLabel><FieldContent className="flex-row items-center gap-2"><Input id="webui-port" className="min-w-0 flex-1 sm:w-[130px] sm:flex-none" type="number" min={1} max={65535} value={port} disabled={disabled} onChange={(event) => setPort(event.target.value)} /><Button variant="outline" size="sm" disabled={disabled} onClick={savePort}>保存</Button></FieldContent></Field>
        </FieldGroup>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="webui-token">访问令牌</FieldLabel>
          <div className="flex flex-wrap gap-2"><Input id="webui-token" className="min-w-0 flex-[1_1_240px]" type="password" autoComplete="new-password" value={webuiToken} placeholder={settings.webui.tokenConfigured ? "输入新令牌以替换" : "输入新令牌"} disabled={disabled} onChange={(event) => setWebuiToken(event.target.value)} /><Button variant="outline" disabled={disabled || webuiToken.trim() === ""} onClick={() => void management.previewSetting("webui.token", { action: "set", value: webuiToken }, "WebUI 访问令牌")}>{settings.webui.tokenConfigured ? "替换令牌" : "设置令牌"}</Button>{settings.webui.tokenConfigured ? <Button variant="destructive" disabled={disabled || settings.webui.host === "0.0.0.0"} onClick={() => void management.previewSetting("webui.token", { action: "clear" }, "WebUI 访问令牌")}>清除令牌</Button> : null}</div>
          <FieldDescription>令牌不会回显或写入浏览器缓存；设置或替换后，请保存新值，并在重启 WebUI 后重新认证。</FieldDescription>
        </Field>
        <SettingsRow label="当前状态" value={settings.webui.tokenConfigured ? "已配置" : "未配置"} />
      </section>

      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">显式网络代理</h3><p className="text-xs text-muted-foreground">现有代理值不会回显；修改后需要重新安装服务定义。</p></div>
        <FieldGroup className="gap-3">
          {proxyFields.map(([field, label, placeholder]) => {
            const configured = settings.network.configuredFields.includes(field)
            return <Field key={field} data-disabled={disabled}>
              <FieldLabel htmlFor={"proxy-" + field}>{label} · {configured ? "已配置" : "未配置"}</FieldLabel>
              <div className="flex flex-wrap gap-2"><Input id={"proxy-" + field} className="min-w-0 flex-[1_1_240px]" type={field === "no_proxy" ? "text" : "password"} autoComplete="off" value={proxyValues[field] ?? ""} placeholder={placeholder} disabled={disabled} onChange={(event) => setProxyValues((current) => ({ ...current, [field]: event.target.value }))} /><Button variant="outline" disabled={disabled || (proxyValues[field]?.trim() ?? "") === ""} onClick={() => setProxy(field, label)}>设置</Button>{configured ? <Button variant="destructive" disabled={disabled} onClick={() => void management.previewSetting("network.proxy", { field, action: "clear" }, label)}>清除</Button> : null}</div>
            </Field>
          })}
        </FieldGroup>
      </section>

      {localError !== null ? <Alert variant="destructive"><AlertDescription>{localError}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>
}
