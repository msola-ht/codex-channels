import { cn } from "cn"
import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { InputTokenTooltip, ReviewUsageSummary, TokenHint } from "@/components/metrics/token-tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatRequestOutcomes, formatTokens } from "@/lib/format"
import type { ModelUsage } from "@/lib/types"

type CardUsage = Pick<ModelUsage, "model" | "requestCount" | "turnCount" | "inputTokens" | "outputTokens" | "cacheUsage" | "usageCoverage">
  & Partial<Pick<ModelUsage, "requestOutcomes" | "members" | "reviewUsage">>

/** 只展示调用方提供的汇总；不在卡片内计算或合并不同统计范围。 */
export function ModelUsageCards({ usage }: { usage: readonly CardUsage[] }) {
  const { t, language } = useTranslation()
  const formatCount = (value: number) => value === 0 ? "" : value.toLocaleString(language === "zh" ? "zh-CN" : "en-US")
  // 每张卡片至少 21rem（窄容器除外），断点包含卡片间距，最多四列。
  return <section aria-label={t("metrics.model")} className="@container/model-usage min-w-0 shrink-0">
    <div className="grid grid-cols-1 gap-2 @[42.5rem]/model-usage:grid-cols-2 @[64rem]/model-usage:grid-cols-3 @[85.5rem]/model-usage:grid-cols-4">
    {usage.map(item => <ModelUsageCard key={JSON.stringify(item.model)} item={item} formatCount={formatCount} />)}
    </div>
  </section>
}

function ModelUsageCard({ item, formatCount }: { item: CardUsage; formatCount: (value: number) => string }) {
  const { t } = useTranslation()
  const name = item.model ?? t("threads.unknownModel")
  const members = item.members ?? []
  const hasDetails = members.length > 0
  const card = <Card size="sm" className="relative min-w-0 gap-1 ring-0">
      {hasDetails && <DialogTrigger render={<Button variant="ghost" />} className="absolute inset-0 size-full cursor-pointer rounded-xl focus-visible:ring-inset" aria-label={t("overview.showModelDetailsLabel", { model: name })} />}
      <CardHeader className={cn("flex min-w-0 flex-wrap items-center gap-2", hasDetails && "pointer-events-none relative [&_[data-slot=tooltip-trigger][tabindex]]:pointer-events-auto")}>
        <CardTitle className="min-w-[min(8rem,100%)] flex-1"><TruncatedText text={name} className="max-w-full" /></CardTitle>
        <dl className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.requests")}</dt>
            <dd className="font-medium tabular-nums">{item.requestOutcomes === undefined
              ? formatCount(item.requestCount)
              : <TableHint hint={formatRequestOutcomes(item.requestOutcomes, t)}>{formatCount(item.requestCount)}</TableHint>}</dd>
          </div>
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.involvedTurns")}</dt>
            <dd className="font-medium tabular-nums">{formatCount(item.turnCount)}</dd>
          </div>
        </dl>
      </CardHeader>
      <CardContent className={cn(hasDetails && "pointer-events-none relative [&_[data-slot=tooltip-trigger][tabindex]]:pointer-events-auto")}>
        <dl className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.inputColumn")}</dt>
            <dd className="font-medium tabular-nums"><InputTokenTooltip
              inputTokens={item.inputTokens}
              requestCount={item.requestCount}
              cachedInputTokens={item.cacheUsage.missingRequestCount > 0 ? null : item.cacheUsage.cachedInputTokens}
              cacheUsage={item.cacheUsage}
            /></dd>
          </div>
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.cacheHitRateColumn")}</dt>
            <dd className="font-medium tabular-nums">{formatCacheUsage(item.cacheUsage).rate}</dd>
          </div>
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.outputColumn")}</dt>
            <dd className="font-medium tabular-nums"><TokenHint value={formatTokens(item.outputTokens)} /></dd>
          </div>
        </dl>
      </CardContent>
  </Card>

  if (!hasDetails) return card

  return <Dialog>
    {card}
    <DialogContent closeLabel={t("common.close")} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl">
      <DialogHeader className="min-w-0 pr-8">
        <DialogTitle className="break-all">{name}</DialogTitle>
        <DialogDescription>{t("overview.modelDetailsHint")}</DialogDescription>
      </DialogHeader>
          <div className="min-w-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t("metrics.provider")}</TableHead><TableHead>{t("overview.originalModel")}</TableHead>
                <TableHead className="text-right">{t("metrics.requests")}</TableHead><TableHead className="text-right"><TableHint hint={t("metrics.involvedTurnsHint")}>{t("metrics.involvedTurns")}</TableHint></TableHead>
                <TableHead className="text-right">{t("metrics.inputColumn")}</TableHead><TableHead className="text-right"><TableHint hint={t("metrics.cacheScopeHint")}>{t("metrics.cacheHitRateColumn")}</TableHint></TableHead><TableHead className="text-right">{t("metrics.outputColumn")}</TableHead>
                <TableHead className="text-right">{t("metrics.reviewTokens")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>{members.map(member => <TableRow key={JSON.stringify([member.provider, member.model])}>
                <TableCell><TruncatedText text={member.provider} className="max-w-48" /></TableCell>
                <TableCell><TruncatedText text={member.model ?? t("threads.unknownModel")} className="max-w-80" /></TableCell>
                <TableCell className="text-right tabular-nums"><TableHint hint={formatRequestOutcomes(member.requestOutcomes, t)}>{formatCount(member.requestCount)}</TableHint></TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(member.turnCount)}</TableCell>
                <TableCell className="text-right tabular-nums"><InputTokenTooltip inputTokens={member.inputTokens} requestCount={member.requestCount} cachedInputTokens={member.cacheUsage.missingRequestCount > 0 ? null : member.cacheUsage.cachedInputTokens} cacheUsage={member.cacheUsage} /></TableCell>
                <TableCell className="text-right tabular-nums">{formatCacheUsage(member.cacheUsage).rate}</TableCell>
                <TableCell className="text-right tabular-nums"><TokenHint value={formatTokens(member.outputTokens)} /></TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums"><ReviewUsageSummary usage={member.reviewUsage} /></TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>
    </DialogContent>
  </Dialog>
}
