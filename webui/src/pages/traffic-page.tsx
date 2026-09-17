import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react"
import { useId } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { TrafficDetail } from "@/components/traffic/traffic-detail"
import { TrafficTable } from "@/components/traffic/traffic-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useTrafficExchange, useTrafficExchanges } from "@/hooks/use-traffic"
import { trafficPageSizeOptions, useTrafficQuery } from "@/hooks/use-traffic-query"

const detailAnchorId = "traffic-exchange-detail"

export function TrafficPage() {
  const labelSelectId = useId()
  const pageSizeSelectId = useId()
  const { query, update } = useTrafficQuery()
  const list = useTrafficExchanges(query)
  const detail = useTrafficExchange(
    query.id === null
      ? null
      : { id: query.id, ...(query.label === undefined ? {} : { label: query.label }) },
  )
  const pageNumber = Math.floor(query.offset / query.limit) + 1

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="shrink-0">
          <h1 className="text-xl font-semibold">转储</h1>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1 text-xs">[debug].model_traffic_dump</code>{" "}
            记录的模型请求与响应字段；只读本机数据目录，默认展示最新标签
          </p>
        </div>
        <div className="flex w-full flex-wrap items-end justify-end gap-3 sm:w-auto sm:flex-1">
          {list.data !== null && list.data.labels.length > 1 ? (
            <Field className="w-48">
              <FieldLabel htmlFor={labelSelectId}>标签</FieldLabel>
              <Select
                value={query.label ?? list.data.label}
                onValueChange={(value) => update({ label: value, id: null }, true)}
              >
                <SelectTrigger id={labelSelectId} size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {list.data.labels.map((entry) => (
                      <SelectItem key={entry.label} value={entry.label}>
                        {entry.label}（{entry.files} 文件）
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={list.loading}
            onClick={() => list.refetch()}
          >
            {list.loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {list.loading ? "刷新中" : "刷新"}
          </Button>
        </div>
      </div>

      <ErrorBanner error={list.error} />
      {list.error !== null && query.label !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => update({ id: null, label: null }, true)}
        >改看最新标签</Button>
      ) : null}
      {list.data !== null && !list.data.enabled ? (
        <Alert>
          <AlertTitle>当前未开启转储</AlertTitle>
          <AlertDescription>
            配置里 <code className="rounded bg-muted px-1 text-xs">[debug].model_traffic_dump</code>{" "}
            关闭时不会再写入新记录，这里显示的是已存在的历史转储文件。
          </AlertDescription>
        </Alert>
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
              selectedId={query.id}
              detailAnchorId={detailAnchorId}
              onSelect={(id) => update({ id: id === query.id ? null : id })}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Label htmlFor={pageSizeSelectId} className="text-sm">每页</Label>
                <Select
                  value={String(query.limit)}
                  onValueChange={(value) => update({ limit: Number(value) }, true)}
                >
                  <SelectTrigger id={pageSizeSelectId} size="sm" className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent side="top">
                    <SelectGroup>
                      {trafficPageSizeOptions.map((size) => (
                        <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground">条 · 共 {list.data.total} 条</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="上一页"
                  disabled={query.offset === 0}
                  onClick={() => update({ offset: Math.max(0, query.offset - query.limit), id: null })}
                >
                  <ChevronLeftIcon />
                </Button>
                <span className="min-w-14 text-center text-sm font-medium">第 {pageNumber} 页</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="下一页"
                  disabled={list.data.nextOffset === null}
                  onClick={() => {
                    const next = list.data?.nextOffset ?? null
                    if (next === null) return
                    update({ offset: next, id: null })
                  }}
                >
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {query.id === null ? null : (
        <Card id={detailAnchorId}>
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
