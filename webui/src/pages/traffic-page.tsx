import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react"
import { useEffect, useId } from "react"

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

export function TrafficPage() {
  const labelSelectId = useId()
  const pageSizeSelectId = useId()
  const { query, update } = useTrafficQuery()
  const list = useTrafficExchanges(query.id === null ? query : null)
  const detail = useTrafficExchange(
    query.id === null
      ? null
      : {
          id: query.id,
          ...(query.label === undefined ? {} : { label: query.label }),
          ...(query.session === undefined ? {} : { session: query.session }),
        },
  )
  const listData = list.data
  const detailData = detail.data
  const pageNumber = Math.floor(query.offset / query.limit) + 1

  useEffect(() => {
    const loaded = query.id === null ? listData : detailData
    if (loaded === null) return
    if (query.label === loaded.label && query.session === loaded.session) return
    update({ label: loaded.label, session: loaded.session }, false, true)
  }, [detailData, listData, query.id, query.label, query.session, update])

  if (query.id !== null) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="shrink-0">
            <h1 className="text-xl font-semibold">明细 #{query.id}</h1>
            <p className="text-sm text-muted-foreground">
              转储包含完整 prompt、代码与工具输出，请勿分享；单段正文超过 4 MiB 时只显示前 4 MiB
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => update({ id: null })}
          >返回列表</Button>
        </div>
        <ErrorBanner error={detail.error} />
        {detail.error !== null ? null : detail.loading || detailData === null
          ? <PageSkeleton rows={6} />
          : <TrafficDetail detail={detailData.exchange} />}
      </div>
    )
  }

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
          {listData !== null && listData.labels.length > 1 ? (
            <Field className="w-48">
              <FieldLabel htmlFor={labelSelectId}>标签</FieldLabel>
              <Select
                value={query.label ?? listData.label}
                onValueChange={(value) => update({ label: value, session: null, id: null }, true)}
              >
                <SelectTrigger id={labelSelectId} size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {listData.labels.map((entry) => (
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
          onClick={() => update({ id: null, label: null, session: null }, true)}
        >改看最新标签</Button>
      ) : null}
      {listData !== null && !listData.enabled ? (
        <Alert>
          <AlertTitle>当前未开启转储</AlertTitle>
          <AlertDescription>
            配置里 <code className="rounded bg-muted px-1 text-xs">[debug].model_traffic_dump</code>{" "}
            关闭时不会再写入新记录，这里显示的是已存在的历史转储文件。
          </AlertDescription>
        </Alert>
      ) : null}

      {list.error !== null ? null : list.loading || listData === null ? <PageSkeleton rows={8} /> : (
        <Card>
          <CardHeader>
            <CardTitle>Exchange（{listData.total}）</CardTitle>
            <CardDescription className="break-all">
              {listData.label} · {listData.files.join("、")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrafficTable
              exchanges={listData.exchanges}
              onOpen={(id) => update({ id, label: listData.label, session: listData.session })}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Label htmlFor={pageSizeSelectId} className="text-sm">每页</Label>
                <Select
                  value={String(query.limit)}
                  onValueChange={(value) => update({
                    label: listData.label,
                    session: listData.session,
                    limit: Number(value),
                  }, true)}
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
                <span className="text-sm text-muted-foreground">条 · 共 {listData.total} 条</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="上一页"
                  disabled={query.offset === 0}
                  onClick={() => update({
                    id: null,
                    label: listData.label,
                    session: listData.session,
                    offset: Math.max(0, query.offset - query.limit),
                  })}
                >
                  <ChevronLeftIcon />
                </Button>
                <span className="min-w-14 text-center text-sm font-medium">第 {pageNumber} 页</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="下一页"
                  disabled={listData.nextOffset === null}
                  onClick={() => {
                    const next = listData.nextOffset
                    if (next === null) return
                    update({
                      id: null,
                      label: listData.label,
                      session: listData.session,
                      offset: next,
                    })
                  }}
                >
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
