import type { CloudUsageMetrics, CloudUsageQuery, CloudUsageReport } from "../application/index.js";
import { formatResetTime, formatTimezoneLine } from "./account-format.js";
import { formatCacheHitRate, formatRequestCount, formatTokenCount } from "./token-format.js";

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

/** Plain literal text; each platform escapes it at its presentation boundary. */
export function formatCloudUsage(report: CloudUsageReport): string {
  const selected = report.totals;
  const candidates = report.groups.filter(group => !services.has(group.model));
  const price = report.remainder !== null ? null : tokenPrice(candidates);
  const hit = selected.inputTokens === null || selected.cachedInputTokens === null
    ? "未提供" : formatCacheHitRate(selected.inputTokens, selected.cachedInputTokens);
  return [
    `Ollama Cloud · ${report.provider}`,
    `${report.query.range === "24h" ? "近 24 小时" : report.query.range === "7d" ? "近 7 天" : "近 30 天"} · 账户用量`,
    formatTimezoneLine(),
    `统计区间：${date(Date.parse(report.from))} 至 ${date(Date.parse(report.until))}`,
    "",
    `请求数量：${formatRequestCount(selected.requestCount)} 次`,
    `输入 Token：${tokens(selected.inputTokens)}`,
    `缓存 Token：${tokens(selected.cachedInputTokens)}`,
    `缓存命中率：${hit}`,
    `输出 Token：${tokens(selected.outputTokens)}`,
    "",
    `已用费用：${selected.usageUsd === null ? "未提供" : `$${selected.usageUsd}`}`,
    `账户剩余费用：${report.balanceUsd === null ? "暂不可用" : `$${report.balanceUsd}`}`,
    `折合单价：${price === null ? "不适用／数据不足" : `$${price} / 1 亿 Token`}`,
    `用量更新：${date(report.observedAtMs)}${report.stale ? "（刷新失败，上次数据）" : ""}`,
    ...(report.balanceObservedAtMs === null ? [] : [`余额更新：${date(report.balanceObservedAtMs)}${report.balanceStale ? "（刷新失败，上次数据）" : ""}`]),
  ].join("\n");
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
