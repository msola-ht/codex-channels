import type { CloudUsageMetrics, CloudUsageQuery, CloudUsageReport } from "../application/index.js";
import { formatResetTime, formatTimezoneLine } from "./account-format.js";
import { formatCacheHitRate, formatObservedTotal, formatRequestCount, formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";

const services = new Set(["web_search", "web_fetch"]);
const units = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};
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
  const candidates = report.groups.filter(group => !services.has(group.model));
  const price = report.remainder !== null ? null : tokenPrice(candidates);
  const hit = selected.inputTokens === null || selected.cachedInputTokens === null
    ? "未提供" : formatCacheHitRate(selected.inputTokens, selected.cachedInputTokens);
  const total = selected.inputTokens === null || selected.outputTokens === null
    ? "未提供" : formatObservedTotal({ inputTokens: selected.inputTokens, outputTokens: selected.outputTokens });
  const uncached = selected.inputTokens === null || selected.cachedInputTokens === null
    ? null : selected.inputTokens - selected.cachedInputTokens;
  return toStructuredMarkdownList([
    `Ollama Cloud · ${report.provider}`,
    "",
    "### 统计范围",
    `范围：${report.query.range === "24h" ? "近 24 小时" : report.query.range === "7d" ? "近 7 天" : "近 30 天"}`,
    formatTimezoneLine(),
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
    `已用费用：${selected.usageUsd === null ? "未提供" : `$${selected.usageUsd}`}`,
    `账户剩余费用：${report.balanceUsd === null ? "暂不可用" : `$${report.balanceUsd}`}`,
    `折合单价：${price === null ? "不适用／数据不足" : `$${price} / 1 亿 Token`}`,
    "",
    "### 数据更新",
    `用量更新：${date(report.observedAtMs)}${report.stale ? "（刷新失败，上次数据）" : ""}`,
    ...(report.balanceObservedAtMs === null ? [] : [`余额更新：${date(report.balanceObservedAtMs)}${report.balanceStale ? "（刷新失败，上次数据）" : ""}`]),
  ].join("\n"));
}

function tokenPrice(groups: CloudUsageMetrics[]): string | null {
  if (!groups.length || groups.some(group => group.inputTokens === null || group.outputTokens === null)) return null;
  // Exclude every zero-token group's fees, not just named search services.
  // Unknown token counts above remain unknown rather than being treated as zero.
  const tokenGroups = groups.filter(group => group.inputTokens! > 0 || group.outputTokens! > 0);
  if (tokenGroups.some(group => group.usageUsd === null)) return null;
  const tokens = tokenGroups.reduce((sum, group) => sum + BigInt(group.inputTokens!) + BigInt(group.outputTokens!), 0n);
  const usd = tokenGroups.reduce((sum, group) => sum + units(group.usageUsd!), 0n);
  if (!tokens) return null;
  if (!usd) return "0.00000";
  // Round only the final displayed price to five decimal places.
  const scaled = (usd * 10_000n + tokens / 2n) / tokens;
  if (scaled === 0n) return "<0.00001";
  return `${scaled / 100_000n}.${(scaled % 100_000n).toString().padStart(5, "0")}`;
}
