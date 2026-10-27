import { calculateCloudUsageEstimates, type CloudUsageQuery, type CloudUsageReport } from "../application/index.js";
import { formatResetTime } from "./account-format.js";
import { formatCacheHitRate, formatObservedTotal, formatRequestCount, formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";

const tokens = (value: number | null): string => value === null ? "未提供" : formatTokenCount(value);
const date = (value: number): string => formatResetTime(value / 1_000, true);

export function cloudUsageChoices(report: CloudUsageReport): Array<{ label: string; input: string }> {
  const input = (range: CloudUsageQuery["range"], refresh = false): string =>
    `${range} account ${report.provider}${refresh ? " refresh" : ""}`;
  return [
    ...(["24h", "7d", "30d"] as const).map(range => ({
      label: `${report.query.range === range ? "当前 · " : ""}${range === "24h" ? "24 小时" : range === "7d" ? "7 天" : "30 天"}`,
      input: input(range),
    })),
    { label: "刷新", input: input(report.query.range, true) },
  ];
}

/** Shared Markdown hierarchy; provider IDs use the validated account identifier alphabet. */
export function formatCloudUsage(report: CloudUsageReport): string {
  const selected = report.totals;
  const { priceUsd: price, priceCny: yuanPrice, allowanceTokens, remainingTokens, proMonthly, priceTokens } = calculateCloudUsageEstimates(report);
  const priceDenominator = `${formatTokenCount(priceTokens)} Token`;
  const estimated = (value: number | null): string => value === null ? "数据不足" : `约 ${formatTokenCount(value)}`;
  const hit = selected.inputTokens === null || selected.cachedInputTokens === null
    ? "未提供" : formatCacheHitRate(selected.inputTokens, selected.cachedInputTokens);
  const total = selected.inputTokens === null || selected.outputTokens === null
    ? "未提供" : formatObservedTotal({ inputTokens: selected.inputTokens, outputTokens: selected.outputTokens });
  const uncached = selected.inputTokens === null || selected.cachedInputTokens === null
    ? null : selected.inputTokens - selected.cachedInputTokens;
  const plan = report.plan === "pro" ? "Pro" : report.plan === "max" ? "Max" : report.plan === "free" ? "Free" : report.plan ?? "暂不可用";
  return toStructuredMarkdownList([
    `Ollama Cloud · ${report.provider}`,
    "",
    "### 额度",
    `套餐额度：${report.allowanceUsd === null ? "未提供" : `$${report.allowanceUsd}`}`,
    `账户剩余费用：${report.balanceUsd === null ? "暂不可用" : `$${report.balanceUsd}`}${report.balanceStale ? "（刷新失败，上次数据）" : ""}`,
    `  - 套餐剩余：${report.includedBalanceUsd === null ? "暂不可用" : `$${report.includedBalanceUsd}`}`,
    `  - 额外购买：${report.purchasedBalanceUsd === null ? "暂不可用" : `$${report.purchasedBalanceUsd}`}`,
    `套餐：${plan}${report.planStale ? "（刷新失败，上次数据）" : ""}`,
    "",
    "### 统计范围",
    `范围：${report.query.range === "24h" ? "近 24 小时" : report.query.range === "7d" ? "近 7 天" : "近 30 天"}${report.stale ? "（刷新失败，上次数据）" : ""}`,
    `开始：${date(Date.parse(report.from))}`,
    `截至：${date(Date.parse(report.until))}`,
    "",
    "### 请求与 Token",
    `请求数量：${formatRequestCount(selected.requestCount)} 次`,
    `- **Token**：${total}`,
    ...(selected.cachedInputTokens === null ? [`  - 输入：${tokens(selected.inputTokens)}`] : []),
    `  - 缓存：${tokens(selected.cachedInputTokens)}`,
    `  - 无缓存：${tokens(uncached)}`,
    `  - 缓存命中率：${hit}`,
    `  - 输出：${tokens(selected.outputTokens)}`,
    "",
    "### 费用",
    `区间已用费用：${selected.usageUsd === null ? "未提供" : `$${selected.usageUsd}`}`,
    `折合单价：${price === null ? "不适用／数据不足" : `$${price} / ${priceDenominator}`}`,
    ...(proMonthly ? [`人民币折合单价：${yuanPrice === null ? report.usdCny ? "数据不足" : "暂不可用" : `约 ¥${yuanPrice} / ${priceDenominator}`}`] : []),
    ...(report.allowanceUsd === null ? [] : [`套餐额度预计可用 Token：${estimated(allowanceTokens)}`]),
    `剩余额度预计可用 Token：${estimated(remainingTokens)}`,
  ].join("\n"));
}
