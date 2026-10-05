import { useTranslation } from "@/hooks/use-translation"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { SettingsRow } from "@/components/settings/settings-controls"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import type { ManagementProvidersResponse, SettingsSummaryResponse } from "@/lib/types"

type Channel = SettingsSummaryResponse["gateway"]["channels"][number]

export function ProviderStatusCard({ state }: { state: ManagementProvidersResponse }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("managementUi.providerStatus")}</CardTitle>
        <CardDescription>{t("managementUi.providerStatusDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 text-sm md:grid-cols-2">
          {state.primary.kind === "official" && !state.official.authenticated ? (
            <>
              <SettingsRow label={t("managementUi.officialLogin")} value={t("managementUi.notLoggedIn")} badge />
              <SettingsRow label={t("managementUi.officialAuthFile")} value={t("managementUi.notDetected")} />
            </>
          ) : (
            <>
              <SettingsRow label={t("managementUi.primaryProvider")} value={state.primary.displayName} badge />
              <SettingsRow label={t("managementUi.primaryProviderId")} value={state.primary.id} code />
            </>
          )}
          <SettingsRow label={t("managementUi.codexDefaultModel")} value={state.defaults.model ?? t("managementUi.followProviderDefault")} />
          <SettingsRow label={t("managementUi.defaultReasoning")} value={state.defaults.reasoningEffort ?? t("managementUi.followModelDefault")} />
          <SettingsRow label={t("managementUi.configVersion")} value={String(state.configVersion ?? t("common.unknown"))} code />
        </div>
        <Separator />
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium">{t("managementUi.discoveredProviders")}</h3>
            <p className="text-xs text-muted-foreground">{t("managementUi.discoveredHint")}</p>
          </div>
          {state.providers.length === 0 ? (
            <SettingsEmpty>
              {state.primary.kind === "official" && !state.official.authenticated
                ? t("managementUi.providersEmptyLoggedOut")
                : t("managementUi.providersEmpty")}
            </SettingsEmpty>
          ) : (
            <Table><TableHeader><TableRow><TableHead>{t("managementUi.provider")}</TableHead><TableHead>{t("modelManagement.mode")}</TableHead><TableHead>{t("modelManagement.model")}</TableHead><TableHead>{t("channelSettings.state")}</TableHead></TableRow></TableHeader><TableBody>
              {state.providers.map(provider => <TableRow key={`${provider.kind}:${provider.id}:${provider.mode}`}>
                <TableCell><div className="flex flex-col gap-1"><span>{provider.displayName}</span><span className="text-xs text-muted-foreground">{provider.id}</span></div></TableCell>
                <TableCell>{t(providerModeKey(provider.mode))}</TableCell>
                <TableCell>{provider.model ?? "—"}{provider.modelCount !== null && ` · ${t("managementUi.modelCount", { count: provider.modelCount })}`}</TableCell>
                <TableCell><Badge variant={provider.selected ? "secondary" : "outline"}>{t(provider.selected ? "managementUi.current" : provider.state === "backup" ? "managementUi.backup" : "managementUi.configured")}</Badge></TableCell>
              </TableRow>)}
            </TableBody></Table>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function ChannelStatusCard({ channels }: { channels: Channel[] }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("channelSettings.title")}</CardTitle>
        <CardDescription>{t("channelSettings.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {channels.length === 0 ? (
          <SettingsEmpty>{t("channelSettings.empty")}</SettingsEmpty>
        ) : <Table><TableHeader><TableRow><TableHead>{t("channelSettings.channel")}</TableHead><TableHead>{t("channelSettings.state")}</TableHead></TableRow></TableHeader><TableBody>{channels.map(channel => <TableRow key={channel.id}><TableCell>{channel.id === "feishu" ? t("managementUi.feishu") : channel.id === "weixin" ? t("managementUi.weixin") : channel.displayName}</TableCell><TableCell><Badge variant={channel.enabled ? "secondary" : "outline"}>{t(channel.enabled ? "channelSettings.enabled" : "channelSettings.disabled")}</Badge></TableCell></TableRow>)}</TableBody></Table>}

      </CardContent>
    </Card>
  )
}

function providerModeKey(mode: ManagementProvidersResponse["providers"][number]["mode"]) {
  if (mode === "exclusive") return "modelManagement.exclusive"
  if (mode === "fixed") return "managementUi.configured"
  return mode === "switching" ? "modelManagement.switching" : "managementUi.backup"
}
