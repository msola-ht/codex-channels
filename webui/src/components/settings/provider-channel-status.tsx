import { useTranslation } from "@/hooks/use-translation"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import type { ManagementProvidersResponse, SettingsSummaryResponse } from "@/lib/types"

type Channel = SettingsSummaryResponse["gateway"]["channels"][number]

export function ProviderStatusCard({ state }: { state: ManagementProvidersResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider 状态</CardTitle>
        <CardDescription>只读显示当前 Provider 与 Codex 默认值；凭据、地址和 Profile 不会返回。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 text-sm md:grid-cols-2">
          {state.primary.kind === "official" && !state.official.authenticated ? (
            <>
              <StatusRow label="OpenAI 官方登录" value="未登录" badge />
              <StatusRow label="官方鉴权文件" value="未检测到" />
            </>
          ) : (
            <>
              <StatusRow label="主 Provider" value={state.primary.displayName} badge />
              <StatusRow label="主 Provider ID" value={state.primary.id} code />
            </>
          )}
          <StatusRow label="Codex 默认模型" value={state.defaults.model ?? "跟随 Provider 默认值"} />
          <StatusRow label="默认思考等级" value={state.defaults.reasoningEffort ?? "跟随模型默认值"} />
          <StatusRow label="配置版本" value={String(state.configVersion ?? "未知")} code />
        </div>
        <Separator />
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium">已发现 Provider</h3>
            <p className="text-xs text-muted-foreground">仅展示可用于当前 Setup 的非凭据摘要。</p>
          </div>
          {state.providers.length === 0 ? (
            <SettingsEmpty>
              {state.primary.kind === "official" && !state.official.authenticated
                ? "当前没有可用的第三方 Provider；OpenAI 官方未登录。"
                : "当前没有额外可切换的 Provider；主 Provider 见上方。"}
            </SettingsEmpty>
          ) : (
            <Table><TableHeader><TableRow><TableHead>提供商</TableHead><TableHead>模式</TableHead><TableHead>模型</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>
              {state.providers.map(provider => <TableRow key={`${provider.kind}:${provider.id}:${provider.mode}`}>
                <TableCell><div className="flex flex-col gap-1"><span>{provider.displayName}</span><span className="text-xs text-muted-foreground">{provider.id}</span></div></TableCell>
                <TableCell>{providerModeLabel(provider.mode)}</TableCell>
                <TableCell>{provider.model ?? "—"}{provider.modelCount !== null && ` · ${provider.modelCount} 个模型`}</TableCell>
                <TableCell><Badge variant={provider.selected ? "secondary" : "outline"}>{provider.selected ? "当前" : providerStateLabel(provider.state)}</Badge></TableCell>
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
        ) : <Table><TableHeader><TableRow><TableHead>{t("channelSettings.channel")}</TableHead><TableHead>{t("channelSettings.state")}</TableHead></TableRow></TableHeader><TableBody>{channels.map(channel => <TableRow key={channel.id}><TableCell>{channel.displayName}</TableCell><TableCell><Badge variant={channel.enabled ? "secondary" : "outline"}>{t(channel.enabled ? "channelSettings.enabled" : "channelSettings.disabled")}</Badge></TableCell></TableRow>)}</TableBody></Table>}

      </CardContent>
    </Card>
  )
}

function StatusRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-muted-foreground">{label}</span>
      {badge ? <Badge className="self-start sm:self-auto" variant="secondary">{value}</Badge> : code ? <code className="max-w-full break-all rounded bg-muted px-2 py-1 text-xs sm:text-right">{value}</code> : <span className="break-words sm:text-right">{value}</span>}
    </div>
  )
}

function providerModeLabel(mode: ManagementProvidersResponse["providers"][number]["mode"]): string {
  if (mode === "exclusive") return "固定主 Provider"
  if (mode === "fixed") return "已配置"
  return mode === "switching" ? "可切换" : "备份"
}

function providerStateLabel(state: ManagementProvidersResponse["providers"][number]["state"]): string {
  return state === "backup" ? "备份" : "已配置"
}
