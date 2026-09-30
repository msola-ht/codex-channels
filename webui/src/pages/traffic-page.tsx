import { Link } from "react-router"
import { RefreshCwIcon } from "lucide-react"
import { useId } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { TrafficDetail } from "@/components/traffic/traffic-detail"
import { TrafficCleanupControls } from "@/components/traffic/traffic-cleanup-controls"
import { TrafficTable } from "@/components/traffic/traffic-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { useTranslation } from "@/hooks/use-translation"
import { formatTime } from "@/lib/format"
import { translateApiError } from "@/lib/i18n/translate"

export function TrafficPage() {
  const { t } = useTranslation()
  const labelSelectId = useId()
  const sessionSelectId = useId()
  const { query, update } = useTrafficQuery()
  const tasks = useManagementTasks()
  const list = useTrafficExchanges(query.id === null ? {
    label: query.label, session: query.session, limit: query.limit, offset: query.offset,
  } : null)
  const detail = useTrafficExchange(
    query.id === null
      ? null
      : {
          traceOffset: query.traceOffset,
          id: query.id,
          ...((query.exchangeLabel ?? query.label) === undefined ? {} : { label: query.exchangeLabel ?? query.label }),
          ...((query.exchangeSession ?? query.session) === undefined
            ? {} : { session: query.exchangeSession ?? query.session }),
        },
  )
  const listData = list.data
  const detailView = detail.displayData
  const pageNumber = Math.floor(query.offset / query.limit) + 1
  const paginationLimited = listData !== null
    && listData.nextOffset === null
    && query.offset + listData.exchanges.length < listData.total
    && query.offset + listData.exchanges.length >= listData.maximumOffset
  // 完整说明带可翻译前缀，配置键本身原样保留并保持 code 展示。
  const dumpKey = "[debug].model_traffic_dump"
  const dumpNotice = t("traffic.dumpDisabledDescription").split("{configKey}")
  // 分页上限说明同理：只翻译说明文字，命令本身原样保留并保持 code 展示。
  const limitNotice = t("traffic.limitDescription", { offset: listData?.maximumOffset.toLocaleString("zh-CN") ?? "" }).split("{command}")

  if (query.id !== null) {
    return (
      <div className="flex min-w-0 shrink-0 flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t("pages.trafficDetail")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("traffic.detailIntro")}
            </p>
          </div>
          <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={detail.loading} onClick={detail.refetch}>
            {detail.loading ? <Spinner aria-label={t("common.loading")} data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}{t("common.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => update({ traceOffset: null, id: null, exchangeSession: null, exchangeLabel: null })}
          >{t("traffic.backToList")}</Button>
          </div>
        </div>
        <ErrorBanner error={translateApiError(t, detail.error, detail.errorCode)} onRetry={detail.refetch} pending={detail.loading} />
        {detailView === null ? detail.error !== null ? null : <PageSkeleton rows={6} /> : (
              <TrafficDetail
                key={`${detailView.label}:${detailView.session}:${detailView.exchange.id}`}
                detail={detailView.exchange}
                provider={detailView.label}
                session={detailView.session}
                traceLoading={detail.loading}
                traceError={detail.error !== null}
                onRetry={detail.refetch}
                onTracePageChange={(traceOffset) => update({ traceOffset, exchangeLabel: detailView.label, exchangeSession: detailView.session })}
              />
            )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{t("pages.traffic")}</h1><Button asChild variant="outline" size="sm"><Link to="/settings/data">{t("navigation.captureSettings")}</Link></Button></div>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1 text-xs">{dumpKey}</code>{" "}
            {t("traffic.listIntro")}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-end gap-3">
          <FieldGroup className="min-w-0 flex-1 flex-row flex-wrap items-end gap-3">
            {listData !== null ? (
              <Field className="w-48">
                <FieldLabel htmlFor={labelSelectId}>{t("traffic.provider")}</FieldLabel>
                <Select
                  value={query.label === undefined ? "all" : `label:${query.label}`}
                  onValueChange={(value) => update({ label: value === "all" ? null : value.slice(6), session: null, exchangeSession: null, id: null }, true)}
                >
                  <SelectTrigger id={labelSelectId} size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">{t("traffic.allProviders")}</SelectItem>
                      {listData.labels.map((entry) => (
                        <SelectItem key={entry.label} value={`label:${entry.label}`}>
                          {t("traffic.providerOption", { label: entry.label, sessions: entry.sessions })}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {listData !== null && listData.label !== null ? (
              <Field className="w-64">
                <FieldLabel htmlFor={sessionSelectId}>{t("traffic.sessionFilterLabel")}</FieldLabel>
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
                      <SelectItem value="all">{t("traffic.allSessions")}</SelectItem>
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
            {list.loading ? <Spinner aria-label={t("common.loading")} data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {list.loading ? t("common.refreshing") : t("common.refresh")}
          </Button>
          <TrafficCleanupControls tasks={tasks} onCompleted={list.refetch} />
        </div>
      </div>

      <ErrorBanner error={translateApiError(t, list.error, list.errorCode)} onRetry={list.refetch} pending={list.loading} />
      <ErrorBanner error={list.turnStatesError === null ? null : t("traffic.turnStatesError", { error: t("traffic.failedBatches", { count: list.turnStatesError.batches.length, batches: list.turnStatesError.batches.join(t("modelComparison.listSeparator")) }) })} onRetry={list.refetchTurnStates} pending={list.turnStatesLoading} />
      {list.error !== null && query.label !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => update({ id: null, label: null, session: null, exchangeSession: null }, true)}
        >{t("traffic.clearScope")}</Button>
      ) : null}
      {listData !== null && !listData.enabled ? (
        <Alert>
          <AlertTitle>{t("traffic.dumpDisabledTitle")}</AlertTitle>
          <AlertDescription>
            {dumpNotice[0]}<code className="rounded bg-muted px-1 text-xs">{dumpKey}</code>{dumpNotice[1]}
          </AlertDescription>
        </Alert>
      ) : null}
      {paginationLimited ? (
        <Alert>
          <AlertTitle>{t("traffic.limitTitle")}</AlertTitle>
          <AlertDescription>
            {limitNotice[0]}<code className="rounded bg-muted px-1 text-xs">codexc traffic</code>{limitNotice[1]}
          </AlertDescription>
        </Alert>
      ) : null}
      {listData !== null ? (
        <p className="text-xs text-muted-foreground">
          {t(["relay.chat", "relay.responses"].includes(query.label ?? "") ? "traffic.relayRetentionNote" : "traffic.retentionNote", { value: listData.retentionDays === 0 ? t("traffic.retentionOff") : t("traffic.retentionDays", { count: listData.retentionDays }) })}
        </p>
      ) : null}

      {list.error !== null ? null : listData === null ? <PageSkeleton rows={8} /> : (
            <TrafficTable
              description={`${listData.label ?? t("traffic.allProviders")} · ${listData.session === null ? t("traffic.allSessionsCount", { count: listData.sessions.length }) : t("traffic.sessionScope", { name: listData.session })}`}
              pagination={{ mode: "server", pageNumber, pageSize: query.limit, pageSizeOptions: trafficPageSizeOptions, serverTotal: listData.total,
                sorting: [], onSortingChange: () => {}, hasPrevious: query.offset > 0, hasNext: listData.nextOffset !== null,
                onPageSizeChange: limit => update({ label: listData.label, session: listData.session, limit }, true),
                onPrevious: () => update({ id: null, label: listData.label, session: listData.session, offset: Math.max(0, query.offset - query.limit) }),
                onNext: () => { if (listData.nextOffset !== null) update({ id: null, label: listData.label, session: listData.session, offset: listData.nextOffset }) } }}
              loading={list.loading}
              exchanges={listData.exchanges}
              turnStates={list.turnStates}
              turnStateErrors={list.turnStateErrors}
              onOpen={(exchange) => update({
                traceOffset: null,
                id: exchange.id,
                exchangeLabel: exchange.label,
                exchangeSession: exchange.session,
              })}
            />

      )}
    </div>
  )
}
