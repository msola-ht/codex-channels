import type { ResponseUsageSummary } from "./request-metrics.js";

/** 流式累加已校验的十进制文本；不经过 SQLite REAL 或 JavaScript Number。 */
export function summarizeResponseUsage(
  rows: Iterable<{ response_usage_amount: string | null }>,
): ResponseUsageSummary | null {
  let total = 0n;
  let scale = 0;
  let observedRequestCount = 0;
  let missingRequestCount = 0;
  for (const row of rows) {
    if (row.response_usage_amount === null) {
      missingRequestCount += 1;
      continue;
    }
    const [whole, fraction = ""] = row.response_usage_amount.split(".");
    const nextScale = Math.max(scale, fraction.length);
    total = total * 10n ** BigInt(nextScale - scale)
      + BigInt(whole! + fraction) * 10n ** BigInt(nextScale - fraction.length);
    scale = nextScale;
    observedRequestCount += 1;
  }
  if (observedRequestCount + missingRequestCount === 0) return null;
  const digits = total.toString().padStart(scale + 1, "0");
  const amount = scale === 0 ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/u, "");
  return { amount: observedRequestCount === 0 ? null : amount, observedRequestCount, missingRequestCount };
}
