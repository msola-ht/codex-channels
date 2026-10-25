import { useTranslation } from "@/hooks/use-translation"
import { Checkbox } from "@/components/ui/checkbox"
import { useEffect } from "react"

import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagedInputRow, ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { UseApiState } from "@/hooks/use-api"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { UpstreamUserAgentResponse } from "@/lib/types"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { DisplayScopeSettings } from "@/components/settings/display-scope-settings"

export function GatewaySettingsCard({ management, upstreamAgent, section = "general" }: {
  management: GatewaySettingsController
  section?: "general" | "permissions" | "network" | "data" | "display"
  upstreamAgent?: UseApiState<UpstreamUserAgentResponse>
}) {
  const { t } = useTranslation()
  const managedSettings = management.managedSettings
  const identity = managedSettings?.system.officialTuiIdentity
  const [draft, patch, reset] = useSettingsDraft({
    followCliVersion: String(identity?.followCliVersion ?? false),
    identityName: identity?.clientIdentity.name ?? "",
    identityTitle: identity?.clientIdentity.title ?? "",
    identityVersion: identity?.clientIdentity.version ?? "",
    upstreamUserAgent: identity?.upstreamUserAgent ?? "",
    terminalIdentity: identity?.terminalIdentity ?? "",
  })
  const { identityName, identityTitle, identityVersion, upstreamUserAgent, terminalIdentity, followCliVersion } = draft
  useEffect(() => {
    if (management.lastAppliedSetting?.kind === "system.official-tui-identity") reset()
  }, [management.lastAppliedSetting, reset])

  if (managedSettings === null) return null
  const disabled = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  const identityDefaults = managedSettings.system.officialTuiIdentity.defaults
  const effectiveUserAgent = upstreamAgent?.data?.effectiveUserAgent ?? null
  const recentRequestUserAgent = upstreamAgent?.data?.recentRequestUserAgent ?? null
  const upstreamAgentValue = upstreamAgent?.error != null
    ? t("settingsFields.uaReadFailed", { message: translateApiErrorCode(t, upstreamAgent.errorCode) })
    : upstreamAgent?.data == null
      ? t("common.loading")
      : effectiveUserAgent ?? t("settingsFields.uaUnavailable")
  const upstreamAgentSource = upstreamAgent?.error != null || upstreamAgent?.data == null
    ? null
    : upstreamAgent?.data.source === "override"
      ? t("settingsFields.explicitOverride")
      : upstreamAgent?.data.source === "app-server" ? t("settingsFields.appServerGenerated") : null
  const upstreamAgentState = effectiveUserAgent === null || recentRequestUserAgent === null
    ? null
    : recentRequestUserAgent === effectiveUserAgent
      ? t("settingsFields.uaEffective")
      : upstreamAgent?.data?.source === "override"
        ? t("settingsFields.uaRestartRequired")
        : t("settingsFields.uaMismatch")
  const saveIdentity = () => {
    void management.previewSetting("system.official-tui-identity", {
      followCliVersion: followCliVersion === "true",
      clientIdentity: {
        name: identityName.trim() || null,
        title: identityTitle.trim() || null,
        version: identityVersion.trim() || null,
      },
      upstreamUserAgent: upstreamUserAgent.trim() || null,
      terminalIdentity: terminalIdentity.trim() || null,
    }, { key: "settingsFields.tuiIdentity" })
  }

  return <Card>
    <CardHeader><CardTitle>{t(section === "display" ? "navigation.channelDisplay" : section === "permissions" ? "navigation.gatewayPermissions" : section === "network" ? "navigation.gatewayNetwork" : section === "data" ? "navigation.gatewayData" : "navigation.gatewayGeneral")}</CardTitle><CardDescription>{t("navigation.configurationHint")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5 text-sm">
      {section !== "network" && <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        {section === "permissions" && <ManagedInputRow saved={management.lastAppliedSetting?.kind === "system.approval-timeout" ? management.lastAppliedSetting : null} label={t("settingsFields.approvalTimeoutSeconds")} type="number" defaultValue={String(managedSettings.system.approvalTimeoutSeconds)} placeholder="30–3600" disabled={disabled} onBlur={(value) => void management.previewSetting("system.approval-timeout", Number(value), { key: "settingsFields.approvalTimeout" })} />}
        {section === "general" && <ManagedInputRow saved={management.lastAppliedSetting?.kind === "system.idle-release-minutes" ? management.lastAppliedSetting : null} label={t("settingsFields.idleReleaseMinutes")} type="number" defaultValue={String(managedSettings.system.idleReleaseMinutes)} placeholder={t("settingsFields.idleReleasePlaceholder")} disabled={disabled} onBlur={(value) => void management.previewSetting("system.idle-release-minutes", Number(value), { key: "settingsFields.idleRelease" })} />}
        {section === "data" && <ManagedSelect label={t("settingsFields.trafficDump")} value={String(managedSettings.system.modelTrafficDumpEnabled)} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={disabled} onChange={(value) => void management.previewSetting("system.model-traffic-dump", value === "true", { key: "settingsFields.trafficDump" })} />}
        {section === "data" && <ManagedSelect description={`${t("capture.values", { inputItems: managedSettings.system.modelTrafficInputItems, itemMaxBytes: managedSettings.system.modelTrafficItemMaxBytes })} ${t("capture.scope")} ${t("capture.activation")}`} label={t("capture.mode")} value={managedSettings.system.modelTrafficMode} options={[
          ...(managedSettings.system.modelTrafficMode === "custom" ? [["custom", t("capture.custom")]] : []),
          ["production", t("capture.production")], ["debug", t("capture.debug")],
        ]} disabledValues={["custom"]} disabled={disabled} onChange={(value) => { if (value === "production" || value === "debug") void management.previewSetting("system.model-traffic-mode", value, { key: "capture.mode" }) }} />}
        {section === "data" && <ManagedInputRow saved={management.lastAppliedSetting?.kind === "system.model-traffic-retention-days" ? management.lastAppliedSetting : null} label={t("settingsFields.trafficRetentionDays")} type="number" defaultValue={String(managedSettings.system.modelTrafficRetentionDays)} placeholder={t("settingsFields.trafficRetentionPlaceholder")} disabled={disabled} onBlur={(value) => void management.previewSetting("system.model-traffic-retention-days", Number(value), { key: "settingsFields.trafficRetentionDays" })} />}
        {section === "permissions" && <ManagedSelect label={t("settingsFields.defaultWorkspace")} value={managedSettings.system.defaultWorkspace ?? ""} options={managedSettings.system.workspaces.map((workspace) => [workspace.id, workspace.name])} disabled={disabled || managedSettings.system.workspaces.length === 0} onChange={(value) => void management.previewSetting("system.default-workspace", value, { key: "settingsFields.defaultWorkspace" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.telegramFormat")} value={managedSettings.telegram.messageFormat} options={[["html", "HTML"], ["rich", t("settingsFields.richText")]]} disabled={disabled || !managedSettings.telegram.configured} onChange={(value) => void management.previewSetting("telegram.message-format", value, { key: "settingsFields.telegramFormat" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.operationUpdates")} value={managedSettings.display.operationUpdates} options={[["full", t("settingsFields.full")], ["compact", t("settingsFields.compact")], ["failures", t("settingsFields.failures")], ["hidden", t("settingsFields.hidden")]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.operation-updates", value, { key: "settingsFields.operationUpdates" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.subagents")} description={t("settingsFields.subagentsHint")} value={managedSettings.display.subagentsOverride === null ? "inherit" : String(managedSettings.display.subagentsOverride)} options={[["inherit", t("settingsFields.subagentsDefault")], ["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={disabled} onChange={value => void management.previewSetting("display.subagents", value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" }, { key: "settingsFields.subagents" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.planUpdates")} value={String(managedSettings.display.planUpdatesEnabled)} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.plan-updates", value === "true", { key: "settingsFields.planUpdates" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.reasoningStatus")} value={String(managedSettings.display.reasoningEnabled)} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabledDefault")]]} disabled={disabled} onChange={(value) => void management.previewSetting("display.reasoning", value === "true", { key: "settingsFields.reasoningStatus" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.completion")} description={t("settingsFields.completionHint")} value={managedSettings.display.completionOverride ?? "inherit"} options={[["inherit", t("settingsFields.completionDefault")], ["off", t("settingsFields.completionOff")], ["brief", t("settingsFields.brief")], ["detailed", t("settingsFields.detailed")]]} disabled={disabled} onChange={value => void management.previewSetting("display.completion", value === "inherit" ? { action: "inherit" } : { action: "set", value }, { key: "settingsFields.completion" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.streaming")} description={t("settingsFields.streamingHint")} value={managedSettings.display.streamingOverride === null ? "inherit" : String(managedSettings.display.streamingOverride)} options={[["inherit", t("settingsFields.streamingDefault")], ["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={disabled} onChange={value => void management.previewSetting("display.streaming", value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" }, { key: "settingsFields.streaming" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.commentary")} description={t("settingsFields.commentaryHint")} value={managedSettings.display.commentaryOverride === null ? "inherit" : String(managedSettings.display.commentaryOverride)} options={[["inherit", t("settingsFields.commentaryDefault")], ["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={disabled} onChange={value => void management.previewSetting("display.commentary", value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" }, { key: "settingsFields.commentary" })} />}
        {section === "display" && <ManagedSelect label={t("settingsFields.presentationDetail")} description={t("settingsFields.presentationDetailHint")} value={managedSettings.display.presentationDetailOverride ?? "inherit"} options={[["inherit", t("settingsFields.presentationDetailDefault")], ["basic", t("settingsFields.basic")], ["detailed", t("settingsFields.detailed")]]} disabled={disabled} onChange={value => void management.previewSetting("display.presentation-detail", value === "inherit" ? { action: "inherit" } : { action: "set", value }, { key: "settingsFields.presentationDetail" })} />}
        {section === "general" && <ManagedSelect label={t("settingsFields.scheduledTasks")} value={String(managedSettings.automation.scheduledTasksEnabled)} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={disabled} onChange={(value) => void management.previewSetting("automation.scheduled-tasks", value === "true", { key: "settingsFields.scheduledTasks" })} />}
        {section === "data" && <ManagedSelect label={t("settingsFields.loggingLevel")} value={managedSettings.advanced.loggingLevel} options={[["fatal", "fatal"], ["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"], ["trace", "trace"]]} disabled={disabled} onChange={(value) => void management.previewSetting("advanced.logging-level", value, { key: "settingsFields.loggingLevel" })} />}
      </FieldGroup>}
      {section === "display" && <DisplayScopeSettings management={management} disabled={disabled} />}

      {section === "network" && <>
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">{t("settingsFields.tuiIdentity")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.tuiIdentityHint", { name: identityDefaults.name, version: identityDefaults.version })}</p></div>
        <Field orientation="horizontal" data-disabled={disabled}>
          <Checkbox id="tui-follow-cli-version" checked={followCliVersion === "true"} disabled={disabled} onCheckedChange={value => patch({ followCliVersion: String(value === true) })} />
          <FieldLabel htmlFor="tui-follow-cli-version">{t("settingsFields.followCliVersion")}</FieldLabel>
        </Field>
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field data-disabled={disabled}><FieldLabel htmlFor="tui-identity-name">{t("settingsFields.identityName")}</FieldLabel><Input id="tui-identity-name" value={identityName} disabled={disabled} maxLength={64} onChange={(event) => patch({ identityName: event.target.value })} placeholder={identityDefaults.name} /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor="tui-identity-title">{t("settingsFields.identityTitle")}</FieldLabel><Input id="tui-identity-title" value={identityTitle} disabled={disabled} maxLength={128} onChange={(event) => patch({ identityTitle: event.target.value })} placeholder={t("settingsFields.optional")} /></Field>
          <Field data-disabled={disabled}><FieldLabel htmlFor="tui-identity-version">{t("settingsFields.identityVersion")}</FieldLabel><Input id="tui-identity-version" value={identityVersion} disabled={disabled} maxLength={64} onChange={(event) => patch({ identityVersion: event.target.value })} placeholder={identityDefaults.version} /></Field>
        </FieldGroup>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="tui-terminal-identity">{t("settingsFields.terminalIdentity")}</FieldLabel>
          <Input id="tui-terminal-identity" value={terminalIdentity} disabled={disabled} maxLength={64} onChange={(event) => patch({ terminalIdentity: event.target.value })} placeholder={t("settingsFields.terminalIdentityPlaceholder")} />
          <FieldDescription>{t("settingsFields.terminalIdentityHint")}</FieldDescription>
        </Field>
        <Field data-disabled={disabled}><FieldLabel htmlFor="tui-upstream-user-agent">{t("settingsFields.upstreamUserAgent")}</FieldLabel><Input id="tui-upstream-user-agent" value={upstreamUserAgent} disabled={disabled} maxLength={512} onChange={(event) => patch({ upstreamUserAgent: event.target.value })} placeholder={t("settingsFields.upstreamUserAgentPlaceholder")} /></Field>
        <Button className="self-start" variant="outline" disabled={disabled} onClick={saveIdentity}>{t("settingsFields.saveIdentity")}</Button>
        <SettingsRow label={t("settingsFields.currentUserAgent")} value={upstreamAgentValue} code />
        {upstreamAgentSource === null ? null : <SettingsRow label={t("settingsFields.uaSource")} value={upstreamAgentSource} />}
        <SettingsRow
          label={t("settingsFields.recentUserAgent")}
          value={recentRequestUserAgent ?? t("settingsFields.noRequestSample")}
          code={recentRequestUserAgent !== null}
        />
        {upstreamAgentState === null ? null : <SettingsRow label={t("settingsFields.activationState")} value={upstreamAgentState} />}
      </section>
      </>}
    </CardContent>
  </Card>
}
