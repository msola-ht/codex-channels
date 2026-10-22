import { useTranslation } from "@/hooks/use-translation"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import type { SettingsSummaryResponse } from "@/lib/types"

type Channel = SettingsSummaryResponse["gateway"]["channels"][number]


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
