import type {
  OfficialAccountSnapshot,
  ProviderAccountLimits,
  ProviderAccountUsage,
} from "./account-port.js";

export function createOfficialAccountSnapshot(input: {
  provider: string;
  accountId?: string | null;
  observedAtMs: number;
  usage: ProviderAccountUsage;
  limits: ProviderAccountLimits;
}): OfficialAccountSnapshot {
  if (!input.provider.trim()) throw new Error("官方账户快照缺少 Provider");
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs <= 0) {
    throw new Error("官方账户快照观测时间无效");
  }
  return {
    provider: input.provider,
    accountId: input.accountId ?? null,
    observedAtMs: input.observedAtMs,
    available: input.usage.kind === "token-usage"
      || ((input.usage.kind === "balance" || input.usage.kind === "quota-windows")
        && input.usage.available),
    usage: input.usage,
    limits: input.limits,
  };
}
