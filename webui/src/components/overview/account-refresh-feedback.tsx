import { useEffect, useState } from "react"
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CardDescription } from "@/components/ui/card"
import { formatTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { accountSnapshotIsStale, scheduleAccountSnapshotExpiry, type AccountRefreshControl } from "@/lib/account-refresh-state"
import { useServerTimeSnapshot } from "@/hooks/use-server-time"
import { estimateServerTime } from "@/lib/server-time"

export function AccountUpdateDescription({ observedAtMs, isDefault, refreshFailed }: {
  observedAtMs: number
  isDefault: boolean
  refreshFailed: boolean
}) {
  const clock = useServerTimeSnapshot()
  const [now, setNow] = useState(() => estimateServerTime(clock))
  useEffect(() => scheduleAccountSnapshotExpiry(observedAtMs, setNow, document, () => estimateServerTime(clock)), [observedAtMs, clock])
  return <CardDescription>
    {isDefault ? "默认账户 · " : ""}
    {observedAtMs > 0 ? `更新于 ${formatTime(observedAtMs)}` : "尚未更新"}
    {refreshFailed ? " · 更新失败" : accountSnapshotIsStale(observedAtMs, now) ? " · 待更新" : ""}
  </CardDescription>
}

export function AccountRefreshButton({ control, retry = false }: {
  control: AccountRefreshControl
  retry?: boolean
}) {
  return <Button variant="outline" size="sm" disabled={control.disabled} onClick={control.onRefresh}>
    {control.refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
    {control.refreshing ? "刷新中" : retry ? "重试" : "刷新"}
  </Button>
}

export function AccountRefreshFeedback({ control, hasSnapshot }: {
  control: AccountRefreshControl | undefined
  hasSnapshot: boolean
}) {
  if (!control?.error) return null
  return <Alert variant={hasSnapshot ? "default" : "destructive"}>
    <AlertCircleIcon />
    <AlertTitle>刷新失败</AlertTitle>
    <AlertDescription>
      <p>{hasSnapshot ? "当前展示上次成功数据。" : "暂未获取到账户数据。"}</p>
      {control.error.message !== "账户刷新失败" ? <p className="break-words">{control.error.message}</p> : null}
      <AccountRefreshButton control={control} retry />
    </AlertDescription>
  </Alert>
}

export function AccountSnapshotEmpty({ control }: { control: AccountRefreshControl | undefined }) {
  if (control?.error) return null
  return <Empty className="p-3">
    <EmptyHeader><EmptyTitle>{control?.refreshing ? "正在获取账户数据" : "暂未获取到账户数据"}</EmptyTitle></EmptyHeader>
    {control ? <AccountRefreshButton control={control} retry /> : null}
  </Empty>
}
