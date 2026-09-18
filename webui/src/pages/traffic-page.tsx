import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react"
import { useEffect, useId } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { TrafficDetail } from "@/components/traffic/traffic-detail"
import { TrafficCleanupControls } from "@/components/traffic/traffic-cleanup-controls"
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { useManagementTasks } from "@/hooks/use-management-tasks"
import { trafficPageSizeOptions, useTrafficQuery } from "@/hooks/use-traffic-query"
import { formatTime } from "@/lib/format"

export function TrafficPage() {
  const labelSelectId = useId()
  const sessionSelectId = useId()
  const pageSizeSelectId = useId()
  const { query, update } = useTrafficQuery()
  const tasks = useManagementTasks()
  const list = useTrafficExchanges(query.id === null ? query : null)
  const detail = useTrafficExchange(
    query.id === null
      ? null
      : {
          traceOffset: query.traceOffset,
          id: query.id,
          ...(query.label === undefined ? {} : { label: query.label }),
          ...((query.exchangeSession ?? query.session) === undefined
            ? {} : { session: query.exchangeSession ?? query.session }),
        },
  )
  const listData = list.data
  const detailData = detail.data
  const pageNumber = Math.floor(query.offset / query.limit) + 1
  const paginationLimited = listData !== null
    && listData.nextOffset === null
    && query.offset + listData.exchanges.length < listData.total
    && query.offset + listData.exchanges.length >= listData.maximumOffset

  useEffect(() => {
    const loaded = query.id === null ? listData : detailData
    if (loaded === null) return
    if (query.id === null) {
      if (query.label !== loaded.label) update({ label: loaded.label }, false, true)
    } else if (detailData !== null
      && (query.label !== detailData.label || query.exchangeSession !== detailData.session)) {
      update({ label: detailData.label, exchangeSession: detailData.session }, false, true)
    }
  }, [detailData, listData, query.id, query.label, query.exchangeSession, update])

  if (query.id !== null) {
    return (
      <div className="flex min-w-0 shrink-0 flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">明细 #{query.id}</h1>
            <p className="text-sm text-muted-foreground">
              批次 {detailData?.session ?? query.exchangeSession ?? query.session} · 原始正文和传输轨迹可展开，每段最多展示 4 MiB
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => update({ traceOffset: null, id: null, exchangeSession: null })}
          >返回列表</Button>
        </div>
        <ErrorBanner error={detail.error} />
        {detail.error !== null ? null : detail.loading || detailData === null
          ? <PageSkeleton rows={6} />
          : (
              <TrafficDetail
                detail={detailData.exchange}
                onTracePageChange={(traceOffset) => update({ traceOffset })}
              />
            )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">转储</h1>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1 text-xs">[debug].model_traffic_dump</code>{" "}
            记录的模型请求与响应字段；默认汇总所选提供商全部保留批次，按请求时间倒序展示
          </p>
        </div>
        <div className="flex w-full flex-wrap items-end gap-3">
          <FieldGroup className="min-w-0 flex-1 flex-row flex-wrap items-end gap-3">
            {listData !== null ? (
              <Field className="w-48">
                <FieldLabel htmlFor={labelSelectId}>提供商</FieldLabel>
                <Select
                  value={query.label ?? listData.label}
                  onValueChange={(value) => update({ label: value, session: null, exchangeSession: null, id: null }, true)}
                >
                  <SelectTrigger id={labelSelectId} size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {listData.labels.map((entry) => (
                        <SelectItem key={entry.label} value={entry.label}>
                          {entry.label}（{entry.sessions} 个批次）
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {listData !== null ? (
              <Field className="w-64">
                <FieldLabel htmlFor={sessionSelectId}>记录批次</FieldLabel>
                <Select
                  value={query.session ?? "all"}
                  onValueChange={(value) => update({
                    session: value === "all" ? null : value, exchangeSession: null, id: null,
                  }, true)}
                >
                  <SelectTrigger id={sessionSelectId} size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部批次</SelectItem>
                      {listData.sessions.map((entry) => (
                        <SelectItem key={entry.session} value={entry.session}>
                          {formatTime(entry.createdAtMs)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </FieldGroup>
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
          <TrafficCleanupControls tasks={tasks} onCompleted={list.refetch} />
        </div>
      </div>

      <ErrorBanner error={list.error} />
      {list.error !== null && query.label !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => update({ id: null, label: null, session: null, exchangeSession: null }, true)}
        >改看最新提供商的全部批次</Button>
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
      {paginationLimited ? (
        <Alert>
          <AlertTitle>已达到转储分页上限</AlertTitle>
          <AlertDescription>
            当前最多翻到 offset {listData.maximumOffset.toLocaleString("zh-CN")}；仍有更早记录时，
            请选择单个记录批次缩小范围，或使用 <code className="rounded bg-muted px-1 text-xs">codexc traffic</code> 查看。
          </AlertDescription>
        </Alert>
      ) : null}
      {listData !== null ? (
        <p className="text-xs text-muted-foreground">
          自动保留：{listData.retentionDays === 0 ? "已关闭" : `${listData.retentionDays} 天`}；
          App Server 启动及新记录批次建立时清理过期历史批次。
        </p>
      ) : null}

      {list.error !== null ? null : list.loading || listData === null ? <PageSkeleton rows={8} /> : (
        <Card>
          <CardHeader>
            <CardTitle>请求记录（{listData.total}）</CardTitle>
            <CardDescription className="break-all">
              {listData.label} · {listData.session === null
                ? `全部 ${listData.sessions.length} 个保留批次` : `批次 ${listData.session}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrafficTable
              exchanges={listData.exchanges}
              onOpen={(exchange) => update({
                traceOffset: null,
                id: exchange.id,
                label: listData.label,
                exchangeSession: exchange.session,
              })}
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
