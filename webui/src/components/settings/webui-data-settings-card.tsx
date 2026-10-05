import { useTranslation } from "@/hooks/use-translation"
import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { MessageKey, TranslateParams } from "@/lib/i18n/messages"

const proxyFields = [
  ["http_proxy", "HTTP_PROXY", "http://127.0.0.1:7890"],
  ["https_proxy", "HTTPS_PROXY", "http://127.0.0.1:7890"],
  ["all_proxy", "ALL_PROXY", "socks5://127.0.0.1:7890"],
  ["no_proxy", "NO_PROXY", "127.0.0.1,localhost"],
] as const

export function WebuiDataSettingsCard({ management, section = "network" }: { management: GatewaySettingsController; section?: "network" | "data" }) {
  const { t } = useTranslation()
  const settings = management.managedSettings
  const [metrics, patchMetrics, resetMetrics] = useSettingsDraft({ retentionDays: settings ? String(settings.metrics.storage.retentionDays) : "", maxRows: settings ? String(settings.metrics.storage.maxRows) : "" })
  const [webui, patchWebui, resetWebui] = useSettingsDraft({ port: settings ? String(settings.webui.port) : "" })
  const { retentionDays, maxRows } = metrics
  const { port } = webui
  const [webuiToken, setWebuiToken] = useState("")
  const [proxyValues, setProxyValues] = useState<Record<string, string>>({})
  const [localError, setLocalError] = useState<{ key: MessageKey; params?: TranslateParams } | null>(null)
  useEffect(() => {
    const saved = management.lastAppliedSetting
    if (saved?.kind === "metrics.storage") resetMetrics()
    if (saved?.kind === "webui.port") resetWebui()
    if (saved?.kind === "webui.token") setWebuiToken("")
    if (saved?.kind === "network.proxy" && typeof saved.value === "object" && saved.value !== null && "field" in saved.value && typeof saved.value.field === "string") {
      const field = saved.value.field
      setProxyValues((previous) => ({ ...previous, [field]: "" }))
    }
  }, [management.lastAppliedSetting, resetMetrics, resetWebui])

  if (settings === null) return null
  const disabled = management.loading || management.error !== null || management.saving || management.pendingSetting !== null

  const saveMetrics = () => {
    const days = Number(retentionDays)
    const rows = Number(maxRows)
    if (!Number.isInteger(days) || days < 1 || days > 3_650) {
      setLocalError({ key: "settingsFields.retentionDaysInvalid" })
      return
    }
    if (!Number.isInteger(rows) || rows < 1_000 || rows > 10_000_000) {
      setLocalError({ key: "settingsFields.maxRowsInvalid" })
      return
    }
    setLocalError(null)
    void management.previewSetting("metrics.storage", { retentionDays: days, maxRows: rows }, { key: "navigation.dataCard" })
  }

  const savePort = () => {
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      setLocalError({ key: "settingsFields.webuiPortInvalid" })
      return
    }
    setLocalError(null)
    void management.previewSetting("webui.port", parsed, { key: "settingsFields.webuiPort" })
  }

  const setProxy = (field: string, label: string) => {
    const value = proxyValues[field]?.trim() ?? ""
    if (value === "") {
      setLocalError({ key: "settingsFields.proxyRequired", params: { label } })
      return
    }
    setLocalError(null)
    void management.previewSetting("network.proxy", { field, action: "set", value }, label)
  }

  return <Card>
    <CardHeader><CardTitle>{t(section === "data" ? "navigation.dataCard" : "navigation.networkCard")}</CardTitle><CardDescription>{t(section === "data" ? "navigation.metricsHint" : "navigation.networkHint")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5 text-sm">
      {section === "data" && <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">{t("navigation.dataCard")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.metricsStorageHint")}</p></div>
        <FieldGroup className="grid gap-3 md:grid-cols-2">
          <Field data-disabled={disabled}><FieldLabel htmlFor="metrics-retention-days">{t("settingsFields.retentionDays")}</FieldLabel><Input id="metrics-retention-days" type="number" min={1} max={3650} value={retentionDays} disabled={disabled} onChange={(event) => patchMetrics({ retentionDays: event.target.value })} /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor="metrics-max-rows">{t("settingsFields.maxRows")}</FieldLabel><Input id="metrics-max-rows" type="number" min={1000} max={10000000} value={maxRows} disabled={disabled} onChange={(event) => patchMetrics({ maxRows: event.target.value })} /></Field>
        </FieldGroup>
        <Button className="self-start" variant="outline" disabled={disabled} onClick={saveMetrics}>{t("settingsFields.saveMetricsStorage")}</Button>
      </section>}

      {section === "network" && <>
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">{t("settingsFields.webuiService")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.webuiServiceHint")}</p></div>
        <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <ManagedSelect label={t("settingsFields.listenAddress")} value={settings.webui.host} options={[["127.0.0.1", "127.0.0.1"], ["::1", "::1"], ["0.0.0.0", "0.0.0.0"]]} disabled={disabled} onChange={(value) => void management.previewSetting("webui.host", value, { key: "settingsFields.webuiHost" })} />
          <Field orientation="responsive" data-disabled={disabled}><FieldLabel className="text-muted-foreground" htmlFor="webui-port">{t("settingsFields.listenPort")}</FieldLabel><FieldContent className="flex-row items-center gap-2"><Input id="webui-port" className="min-w-0 flex-1 sm:w-[130px] sm:flex-none" type="number" min={1} max={65535} value={port} disabled={disabled} onChange={(event) => patchWebui({ port: event.target.value })} /><Button variant="outline" size="sm" disabled={disabled} onClick={savePort}>{t("settingsFields.save")}</Button></FieldContent></Field>
        </FieldGroup>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="webui-token">{t("settingsFields.accessToken")}</FieldLabel>
          <div className="flex flex-wrap gap-2"><Input id="webui-token" className="min-w-0 flex-[1_1_240px]" type="password" autoComplete="new-password" value={webuiToken} placeholder={t(settings.webui.tokenConfigured ? "settingsFields.replaceTokenPlaceholder" : "settingsFields.newTokenPlaceholder")} disabled={disabled} onChange={(event) => setWebuiToken(event.target.value)} /><Button variant="outline" disabled={disabled || webuiToken.trim() === ""} onClick={() => void management.previewSetting("webui.token", { action: "set", value: webuiToken }, { key: "settingsFields.webuiToken" })}>{t(settings.webui.tokenConfigured ? "settingsFields.replaceToken" : "settingsFields.setToken")}</Button>{settings.webui.tokenConfigured ? <Button variant="destructive" disabled={disabled || settings.webui.host === "0.0.0.0"} onClick={() => void management.previewSetting("webui.token", { action: "clear" }, { key: "settingsFields.webuiToken" })}>{t("settingsFields.clearToken")}</Button> : null}</div>
          <FieldDescription>{t("settingsFields.tokenHint")}</FieldDescription>
        </Field>
        <SettingsRow label={t("settingsFields.currentState")} value={t(settings.webui.tokenConfigured ? "settingsFields.configured" : "settingsFields.notConfigured")} />
      </section>

      <Separator />
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">{t("settingsFields.networkProxy")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.networkProxyHint")}</p></div>
        <FieldGroup className="gap-3">
          {proxyFields.map(([field, label, placeholder]) => {
            const configured = settings.network.configuredFields.includes(field)
            return <Field key={field} data-disabled={disabled}>
              <FieldLabel htmlFor={"proxy-" + field}>{label} · {t(configured ? "settingsFields.configured" : "settingsFields.notConfigured")}</FieldLabel>
              <div className="flex flex-wrap gap-2"><Input id={"proxy-" + field} className="min-w-0 flex-[1_1_240px]" type={field === "no_proxy" ? "text" : "password"} autoComplete="off" value={proxyValues[field] ?? ""} placeholder={placeholder} disabled={disabled} onChange={(event) => setProxyValues((current) => ({ ...current, [field]: event.target.value }))} /><Button variant="outline" disabled={disabled || (proxyValues[field]?.trim() ?? "") === ""} onClick={() => setProxy(field, label)}>{t("settingsFields.set")}</Button>{configured ? <Button variant="destructive" disabled={disabled} onClick={() => void management.previewSetting("network.proxy", { field, action: "clear" }, label)}>{t("settingsFields.clear")}</Button> : null}</div>
            </Field>
          })}
        </FieldGroup>
      </section>
      </>}

      {localError !== null ? <Alert variant="destructive"><AlertDescription>{t(localError.key, localError.params)}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>
}
