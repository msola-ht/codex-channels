import { useState } from "react"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { InputTokenTooltip } from "@/components/metrics/token-tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatModelName, formatRequestOutcomes, formatTokens } from "@/lib/format"
import type { ModelUsage } from "@/lib/types"

type CardUsage = Pick<ModelUsage, "model" | "requestCount" | "turnCount" | "inputTokens" | "outputTokens" | "cacheUsage">
  & Partial<Pick<ModelUsage, "requestOutcomes" | "members">>

/** 只展示调用方提供的汇总；不在卡片内计算或合并不同统计范围。 */
export function ModelUsageCards({ usage, grouped = false }: { usage: readonly CardUsage[]; grouped?: boolean }) {
  const { t, language } = useTranslation()
  const formatCount = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en-US")
  // 每张卡片至少 21rem（窄容器除外），断点包含卡片间距，最多四列。
  return <section aria-label={t("metrics.model")} className="@container/model-usage min-w-0 shrink-0">
    <div className="grid grid-cols-1 gap-2 @[42.5rem]/model-usage:grid-cols-2 @[64rem]/model-usage:grid-cols-3 @[85.5rem]/model-usage:grid-cols-4">
    {usage.map(item => <ModelUsageCard key={JSON.stringify(item.model)} item={item} grouped={grouped} formatCount={formatCount} />)}
    </div>
  </section>
}

function ModelUsageCard({ item, grouped, formatCount }: { item: CardUsage; grouped: boolean; formatCount: (value: number) => string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const name = (grouped ? item.model : formatModelName(item.model, null)) ?? t("threads.unknownModel")
  const members = item.members ?? []
  return <Collapsible open={expanded} onOpenChange={setExpanded} render={<Card size="sm" className={cn("min-w-0 gap-1", expanded && "col-span-full")} />}>
      <CardHeader className="flex min-w-0 flex-wrap items-center gap-2">
        <CardTitle className="min-w-[min(8rem,100%)] flex-1"><TruncatedText text={name} className="max-w-full" /></CardTitle>
        <dl className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.requests")}</dt>
            <dd className="font-medium tabular-nums">{item.requestOutcomes === undefined
              ? formatCount(item.requestCount)
              : <TableHint hint={formatRequestOutcomes(item.requestOutcomes, t)}>{formatCount(item.requestCount)}</TableHint>}</dd>
          </div>
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.turn")}</dt>
            <dd className="font-medium tabular-nums">{formatCount(item.turnCount)}</dd>
          </div>
        </dl>
        {members.length > 0 && <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} aria-label={t(expanded ? "overview.hideModelDetailsLabel" : "overview.showModelDetailsLabel", { model: name })}>
          {expanded ? <ChevronUpIcon data-icon="inline-start" /> : <ChevronDownIcon data-icon="inline-start" />}
          {expanded ? t("overview.hideModelDetails") : t("overview.showModelDetails", { count: members.length })}
        </CollapsibleTrigger>}
      </CardHeader>
      <CardContent>
        <dl className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1 whitespace-nowrap">
            <dt className="text-muted-foreground">{t("metrics.inputColumn")}</dt>
            <dd className="font-medium tabular-nums"><InputTokenTooltip
              inputTokens={item.inputTokens}
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
            <dd className="font-medium tabular-nums">{formatTokens(item.outputTokens)}</dd>
          </div>
        </dl>
        {members.length > 0 && <CollapsibleContent>
          <div className="flex flex-col gap-2 pt-3">
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t("metrics.provider")}</TableHead><TableHead>{t("overview.originalModel")}</TableHead>
                <TableHead className="text-right">{t("metrics.requests")}</TableHead><TableHead className="text-right">{t("metrics.turn")}</TableHead>
                <TableHead className="text-right">{t("metrics.inputColumn")}</TableHead><TableHead className="text-right">{t("metrics.cacheHitRateColumn")}</TableHead><TableHead className="text-right">{t("metrics.outputColumn")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>{members.map(member => <TableRow key={JSON.stringify([member.provider, member.model])}>
                <TableCell><TruncatedText text={member.provider} className="max-w-48" /></TableCell>
                <TableCell><TruncatedText text={member.model ?? t("threads.unknownModel")} className="max-w-80" /></TableCell>
                <TableCell className="text-right tabular-nums"><TableHint hint={formatRequestOutcomes(member.requestOutcomes, t)}>{formatCount(member.requestCount)}</TableHint></TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(member.turnCount)}</TableCell>
                <TableCell className="text-right tabular-nums"><InputTokenTooltip inputTokens={member.inputTokens} cachedInputTokens={member.cacheUsage.missingRequestCount > 0 ? null : member.cacheUsage.cachedInputTokens} cacheUsage={member.cacheUsage} /></TableCell>
                <TableCell className="text-right tabular-nums">{formatCacheUsage(member.cacheUsage).rate}</TableCell>
                <TableCell className="text-right tabular-nums">{formatTokens(member.outputTokens)}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">{t("overview.modelDetailsHint")}</p>
          </div>
        </CollapsibleContent>}
      </CardContent>
  </Collapsible>
}
