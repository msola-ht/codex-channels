import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { TrafficDetail } from "@/components/traffic/traffic-detail"
import { TrafficTable } from "@/components/traffic/traffic-table"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useTrafficExchange, useTrafficExchanges } from "@/hooks/use-traffic"

const pageSize = 50

export function TrafficPage() {
  const [params, setParams] = useSearchParams()
  const label = params.get("label") ?? undefined
  const selectedParam = params.get("id")
  const selected = selectedParam !== null && /^[0-9]+$/u.test(selectedParam)
    ? Number(selectedParam)
    : null
  const [offset, setOffset] = useState(0)
  const detailRef = useRef<HTMLDivElement | null>(null)
  const list = useTrafficExchanges({ label, limit: pageSize, offset })
  const detail = useTrafficExchange(selected === null ? null : { id: selected, label })
  const pageNumber = Math.floor(offset / pageSize) + 1
  const select = (id: number | null) => {
    const next = new URLSearchParams(params)
    if (id === null) next.delete("id")
    else next.set("id", String(id))
    setParams(next)
  }
  useEffect(() => {
    if (selected === null) return
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [selected, detail.data])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">转储</h1>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1 text-xs">[debug].model_traffic_dump</code>{" "}
            记录的模型请求与响应字段；只读本机数据目录，默认展示最新标签
          </p>
        </div>
        <div className="flex items-center gap-2">
          {list.data !== null && list.data.labels.length > 1 ? (
            <Select
              value={label ?? list.data.label}
              onValueChange={(value) => {
                const next = new URLSearchParams(params)
                next.set("label", value)
                next.delete("id")
                setParams(next)
                setOffset(0)
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.data.labels.map((entry) => (
                  <SelectItem key={entry.label} value={entry.label}>
                    {entry.label}（{entry.files} 文件）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => list.refetch()}>
            刷新
          </Button>
        </div>
      </div>

      <ErrorBanner error={list.error} />
      {list.error !== null && label !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            const next = new URLSearchParams(params)
            next.delete("id")
            next.delete("label")
            setParams(next)
            setOffset(0)
          }}
        >改看最新标签</Button>
      ) : null}
      {list.data !== null && !list.data.enabled ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          当前未开启 <code className="rounded bg-muted px-1">[debug].model_traffic_dump</code>
          ，这里显示的是已存在的历史转储文件。
        </p>
      ) : null}

      {list.error !== null ? null : list.loading || list.data === null ? <PageSkeleton rows={8} /> : (
        <Card>
          <CardHeader>
            <CardTitle>Exchange（{list.data.total}）</CardTitle>
            <CardDescription className="break-all">
              {list.data.label} · {list.data.files.join("、")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrafficTable
              exchanges={list.data.exchanges}
              selectedId={selected}
              onSelect={(id) => select(id === selected ? null : id)}
            />
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">第 {pageNumber} 页</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - pageSize))
                    select(null)
                  }}
                >上一页</Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={list.data.nextOffset === null}
                  onClick={() => {
                    if (list.data?.nextOffset === null || list.data === null) return
                    setOffset(list.data.nextOffset)
                    select(null)
                  }}
                >下一页</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {selected === null ? null : (
        <Card ref={detailRef}>
          <CardHeader>
            <CardTitle>明细</CardTitle>
            <CardDescription>
              转储包含完整 prompt、代码与工具输出，请勿分享；单段正文超过 4 MiB 时只显示前 4 MiB
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ErrorBanner error={detail.error} />
            {detail.error !== null ? null : detail.loading || detail.data === null
              ? <PageSkeleton rows={6} />
              : <TrafficDetail detail={detail.data.exchange} />}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
