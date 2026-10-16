const compactTwoDecimalFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 2,
});

const compactThreeDecimalFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 3,
});

export function formatTokenCount(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return formatCompactNumber(value, 3);
  if (Math.abs(value) >= 1_000) return formatCompactNumber(value, 2);
  return value.toLocaleString("zh-CN");
}

export function formatObservedTokens(value: number, requestCount: number, missing: number | undefined): string {
  if (requestCount === 0) return "0";
  if (missing === undefined) return `${formatTokenCount(value)}（覆盖未知）`;
  if (missing === requestCount) return "未观测";
  return `${missing > 0 ? "≥ " : ""}${formatTokenCount(value)}`;
}

export function formatObservedTotal(usage: {
  requestCount: number; inputTokens: number; outputTokens: number;
  usageCoverage?: { inputMissingRequestCount: number; outputMissingRequestCount: number } | undefined;
}): string {
  const coverage = usage.usageCoverage;
  if (usage.requestCount === 0) return "0";
  if (!coverage) return `${formatTokenCount(usage.inputTokens + usage.outputTokens)}（覆盖未知）`;
  if (coverage.inputMissingRequestCount === usage.requestCount && coverage.outputMissingRequestCount === usage.requestCount) return "未观测";
  return `${coverage.inputMissingRequestCount + coverage.outputMissingRequestCount > 0 ? "≥ " : ""}${formatTokenCount(usage.inputTokens + usage.outputTokens)}`;
}

export function formatRequestCount(value: number): string {
  if (Math.abs(value) >= 1_000) return formatCompactNumber(value, 2);
  return value.toLocaleString("zh-CN");
}

export function formatCacheHitRate(
  inputTokens: number,
  cachedInputTokens: number,
): string {
  return inputTokens > 0
    ? `${Math.max(
        0,
        cachedInputTokens / inputTokens * 100,
      ).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}%`
    : "未知";
}

function formatCompactNumber(
  value: number,
  maximumFractionDigits: number,
): string {
  const formatted = maximumFractionDigits === 3
    ? compactThreeDecimalFormatter.format(value)
    : compactTwoDecimalFormatter.format(value);
  return formatted.replace(/([A-Z]+)$/u, " $1");
}
