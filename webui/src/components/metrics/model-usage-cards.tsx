import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { InputTokenTooltip } from "@/components/metrics/token-tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatModelName, formatRequestOutcomes, formatTokens } from "@/lib/format"
import type { ModelUsage } from "@/lib/types"

type CardUsage = Pick<ModelUsage, "model" | "requestCount" | "turnCount" | "inputTokens" | "outputTokens" | "cacheUsage">
  & Partial<Pick<ModelUsage, "requestOutcomes">>

/** 只展示调用方提供的汇总；不在卡片内计算或合并不同统计范围。 */
export function ModelUsageCards({ usage }: { usage: readonly CardUsage[] }) {
  const { t, language } = useTranslation()
  const formatCount = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en-US")
  // 每张卡片至少 21rem（窄容器除外），断点包含卡片间距，最多四列。
  return <section aria-label={t("metrics.model")} className="@container/model-usage min-w-0 shrink-0">
    <div className="grid grid-cols-1 gap-2 @[42.5rem]/model-usage:grid-cols-2 @[64rem]/model-usage:grid-cols-3 @[85.5rem]/model-usage:grid-cols-4">
    {usage.map(item => <Card key={JSON.stringify(item.model)} size="sm" className="min-w-0 gap-1">
      <CardHeader className="flex min-w-0 flex-wrap items-center gap-2">
        <CardTitle className="min-w-[min(8rem,100%)] flex-1"><TruncatedText text={formatModelName(item.model, null) ?? t("threads.unknownModel")} className="max-w-full" /></CardTitle>
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
      </CardContent>
    </Card>)}
    </div>
  </section>
}
