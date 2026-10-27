import type { CloudUsageMetrics, CloudUsageReport } from "./account-port.js";
import type { CloudUsageEstimates } from "../../runtime/ollama-cloud-usage.mjs";
export type { CloudUsageEstimates, CloudUsageView } from "../../runtime/ollama-cloud-usage.mjs";

const services = new Set(["web_search", "web_fetch"]);
const units = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};

/** Pure estimates from validated official data, shared by channel and WebUI views. */
export function calculateCloudUsageEstimates(report: CloudUsageReport): CloudUsageEstimates {
  const candidates = report.groups.filter(group => !services.has(group.model));
  const basis = report.remainder !== null ? null : tokenBasis(candidates);
  const allowance = report.allowanceUsd === null ? null : units(report.allowanceUsd);
  const estimate = (amount: string | null): number | null => {
    if (amount === null) return null;
    const credit = units(amount);
    if (credit === 0n) return 0;
    if (!basis || basis.usd === 0n) return null;
    const count = credit * basis.tokens / basis.usd;
    return count > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(count);
  };
  const proMonthly = report.plan === "pro" && allowance === 60_000_000_000n;
  return {
    priceUsd: basis === null ? null : decimalRatio(basis.usd * 10_000n, basis.tokens),
    priceCny: proMonthly && basis && report.usdCny
      ? decimalRatio(basis.usd * 10_000n * BigInt(Math.round(report.usdCny.rate * 1_000_000)), basis.tokens * 3_000_000n) : null,
    allowanceTokens: estimate(report.allowanceUsd),
    remainingTokens: estimate(report.balanceUsd),
    proMonthly,
    priceTokens: 100_000_000,
  };
}

function tokenBasis(groups: CloudUsageMetrics[]): { usd: bigint; tokens: bigint } | null {
  if (!groups.length || groups.some(group => group.inputTokens === null || group.outputTokens === null)) return null;
  // Exclude every zero-token group's fees, not just named search services.
  const tokenGroups = groups.filter(group => group.inputTokens! > 0 || group.outputTokens! > 0);
  if (tokenGroups.some(group => group.usageUsd === null)) return null;
  const tokens = tokenGroups.reduce((sum, group) => sum + BigInt(group.inputTokens!) + BigInt(group.outputTokens!), 0n);
  const usd = tokenGroups.reduce((sum, group) => sum + units(group.usageUsd!), 0n);
  return tokens ? { usd, tokens } : null;
}

function decimalRatio(numerator: bigint, denominator: bigint): string {
  if (!numerator) return "0.00000";
  // Round only the final displayed price to five decimal places.
  const scaled = (numerator + denominator / 2n) / denominator;
  if (scaled === 0n) return "<0.00001";
  return `${scaled / 100_000n}.${(scaled % 100_000n).toString().padStart(5, "0")}`;
}
