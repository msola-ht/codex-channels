import type { ProviderAccountUsage } from "../application/index.js";
import type { CompletionAccountStatus } from "../conversation-core/index.js";

export function completionAccountStatus(
  provider: string,
  usage: ProviderAccountUsage,
): CompletionAccountStatus | undefined {
  if (usage.provider !== provider) return undefined;
  if (usage.kind === "balance") {
    if (usage.balances.length === 0) return undefined;
    return { provider, balances: usage.balances.map(({ currency, totalBalance }) => ({ currency, remaining: totalBalance })), windows: [] };
  }
  if (usage.kind === "quota-windows" || usage.kind === "credit-usage") {
    if (usage.kind === "quota-windows" && usage.windows.length === 0) return undefined;
    return {
      provider,
      balances: [],
      ...(usage.kind === "credit-usage" ? { credits: usage.totalRemaining } : {}),
      windows: usage.windows.map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent, resetsAt })),
    };
  }
  return undefined;
}
