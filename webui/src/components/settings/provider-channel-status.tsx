import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
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
          <StatusRow label="主 Provider" value={state.primary.displayName} badge />
          <StatusRow label="主 Provider ID" value={state.primary.id} code />
          <StatusRow label="Codex 默认模型" value={state.defaults.model ?? "跟随 Provider 默认值"} />
          <StatusRow label="默认思考等级" value={state.defaults.reasoningEffort ?? "跟随模型默认值"} />
          <StatusRow label="配置版本" value={String(state.configVersion ?? "未知")} code />
          <StatusRow label="共享第三方子代理" value={externalAgentLabel(state.externalAgent)} />
        </div>
        <Separator />
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium">已发现 Provider</h3>
            <p className="text-xs text-muted-foreground">仅展示可用于当前 Setup 的非凭据摘要。</p>
          </div>
          {state.providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">当前没有额外可切换的 Provider；主 Provider 见上方。</p>
          ) : (
            <div className="flex flex-col gap-3">
              {state.providers.map((provider, index) => (
                <div key={`${provider.kind}:${provider.id}:${provider.mode}`}>
                  {index > 0 ? <Separator className="mb-3" /> : null}
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">{provider.displayName}</span>
                      <span className="text-xs text-muted-foreground">
                        {provider.id} · {providerModeLabel(provider.mode)}
                        {provider.model === null ? "" : ` · ${provider.model}`}
                        {provider.modelCount === null ? "" : ` · ${provider.modelCount} 个模型`}
                      </span>
                    </div>
                    <Badge variant={provider.selected ? "secondary" : "outline"}>
                      {provider.selected ? "当前" : providerStateLabel(provider.state)}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function ChannelStatusCard({ channels }: { channels: Channel[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>通讯渠道状态</CardTitle>
        <CardDescription>来源为 Gateway 配置快照；渠道凭据、允许名单和运行连接不在 WebUI 展示。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前没有已配置的通讯渠道。</p>
        ) : channels.map((channel, index) => (
          <div key={channel.id}>
            {index > 0 ? <Separator className="mb-3" /> : null}
            <div className="flex items-center justify-between gap-4 text-sm">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{channel.displayName}</span>
                <span className="text-xs text-muted-foreground">Gateway 配置</span>
              </div>
              <Badge variant={channel.enabled ? "secondary" : "outline"}>
                {channel.enabled ? "已启用" : "已配置，未启用"}
              </Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function StatusRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      {badge ? <Badge variant="secondary">{value}</Badge> : code ? <code className="rounded bg-muted px-2 py-1 text-xs">{value}</code> : <span className="text-right">{value}</span>}
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

function externalAgentLabel(agent: ManagementProvidersResponse["externalAgent"]): string {
  if (agent.status === "configured") return `${agent.provider ?? "未知 Provider"} · ${agent.model ?? "未知模型"}`
  return agent.status === "unavailable" ? "已配置但不可用" : "未配置"
}
