import { useApi } from "@/hooks/use-api"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { useTranslation } from "@/hooks/use-translation"
import { fetchSettingsSummary } from "@/lib/api"
import { SettingsPageFrame } from "@/components/settings/settings-page-frame"
import { GatewaySettingsSection } from "@/components/settings/gateway-settings-section"
import { GatewaySettingsCard } from "@/components/settings/gateway-settings-card"
import { ChannelStatusCard } from "@/components/settings/provider-channel-status"
import { SettingsCliCommandList } from "@/components/settings/settings-cli-commands"
import { SettingsError, LoadingSettingsCard } from "@/components/settings/settings-feedback"

export function ChannelsPage() {
  const { t } = useTranslation()
  const summary = useApi(fetchSettingsSummary, [])
  return <SettingsPageFrame title="navigation.channelConfiguration" busy={summary.loading} refresh={summary.refetch}>
    {summary.error ? <SettingsError message={summary.error} retry={summary.refetch} /> : summary.data ? <ChannelStatusCard channels={summary.data.gateway.channels} /> : <LoadingSettingsCard title={t("navigation.channelConfiguration")} />}
    {summary.data && <SettingsCliCommandList scope="channels" entries={summary.data.cli} />}
  </SettingsPageFrame>
}

export function ChannelDisplayPage() {
  const gateway = useSettingsManagement()
  return <SettingsPageFrame title="navigation.channelDisplay" busy={gateway.loading || gateway.saving || gateway.pendingSetting !== null} refresh={gateway.refetch}>
    <GatewaySettingsSection management={gateway}><GatewaySettingsCard management={gateway} section="display" /></GatewaySettingsSection>
  </SettingsPageFrame>
}
