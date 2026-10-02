import { isClinePassAccountProvider } from "../../runtime/cline-pass-accounts.mjs";
import type { ManagedModelProviderId } from "../../runtime/model-provider-definitions.mjs";
import { loadConfiguredProviderCredential } from "../../runtime/model-provider-runtime.mjs";
import type { ProviderAccountAdapter, ProviderAccountUsage, ProviderQuotaWindow } from "../application/index.js";
import { AccountQuery } from "./account-query.js";

const usageUrl = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";
const windowDefinitions = [
  { type: "five_hour", windowId: "five-hour", label: "5小时" },
  { type: "weekly", windowId: "weekly", label: "7天" },
  { type: "monthly", windowId: "monthly", label: "月度" },
] as const;

export function createClinePassAccountAdapter(options: {
  provider: ManagedModelProviderId;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): ProviderAccountAdapter {
  if (!isClinePassAccountProvider(options.provider)) throw new Error("CLP 账户 Provider 无效");
  return {
    provider: options.provider,
    async accountUsage(signal) {
      const query = new AccountQuery("CLP", signal);
      return query.run(async () => {
        const { apiKey } = loadConfiguredProviderCredential(options.provider, options.environment ?? process.env);
        const { body } = await query.json(options.fetchImpl ?? fetch, usageUrl, apiKey, "usage", { redirect: "error" });
        return parseUsage(body, options.provider);
      });
    },
  };
}

function parseUsage(value: unknown, provider: string): ProviderAccountUsage {
  const response = record(value);
  const limits = record(response.data).limits;
  if (response.success !== true || !Array.isArray(limits)) {
    throw new Error("Invalid CLP usage response");
  }
  // 上游新增的窗口类型不进入 CLP 的展示口径；三个已知窗口仍必须齐全且唯一。
  const windows = windowDefinitions.map(({ type, windowId, label }): ProviderQuotaWindow => {
    const matches = limits.map(record).filter(limit => limit.type === type);
    if (matches.length !== 1) throw new Error("Missing or duplicate CLP window");
    const { percentUsed, resetsAt } = matches[0]!;
    if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed) || percentUsed < 0) {
      throw new Error("Invalid CLP percentage");
    }
    // An upstream window may omit its reset time. Do not invent a countdown.
    // When supplied, it must be an RFC 3339 UTC timestamp with fractional seconds.
    let resetSeconds: number | null = null;
    if (resetsAt !== undefined) {
      if (typeof resetsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(resetsAt)) throw new Error("Invalid CLP reset time");
      const resetMs = Date.parse(resetsAt);
      if (!Number.isFinite(resetMs) || resetMs <= 0 || new Date(resetMs).toISOString().slice(0, 19) !== resetsAt.slice(0, 19)) throw new Error("Invalid CLP reset time");
      resetSeconds = Math.floor(resetMs / 1_000);
    }
    return { windowId, label, usedPercent: percentUsed, resetsAt: resetSeconds, status: null };
  });
  return { kind: "quota-windows", provider, available: true, windows };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid CLP response object");
  return value as Record<string, unknown>;
}
