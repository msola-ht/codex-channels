import { isClinePassAccountProvider } from "../../runtime/cline-pass-accounts.mjs";
import type { ManagedModelProviderId } from "../../runtime/model-provider-definitions.mjs";
import { loadConfiguredProviderCredential } from "../../runtime/model-provider-runtime.mjs";
import type { ProviderAccountAdapter, ProviderAccountUsage, ProviderQuotaWindow } from "../application/index.js";
import { UserFacingError } from "../conversation-core/index.js";
import { readBoundedFetchBody } from "./bounded-fetch-body.js";

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
    async accountUsage() {
      try {
        const { apiKey } = loadConfiguredProviderCredential(options.provider, options.environment ?? process.env);
        const response = await (options.fetchImpl ?? fetch)(usageUrl, {
          method: "GET", redirect: "error",
          headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("CLP usage request failed");
        const body = await readBoundedFetchBody(response, 65_536, {
          invalidContentLength: () => new Error("Invalid CLP response length"),
          tooLarge: () => new Error("CLP response too large"),
          missingBody: () => new Error("Missing CLP response body"),
        });
        return parseUsage(JSON.parse(body.toString("utf8")) as unknown, options.provider);
      } catch {
        throw new UserFacingError("provider.account.unavailable", "CLP 账户查询失败", { provider: "CLP" });
      }
    },
  };
}

function parseUsage(value: unknown, provider: string): ProviderAccountUsage {
  const response = record(value);
  const limits = record(response.data).limits;
  if (response.success !== true || !Array.isArray(limits) || limits.length !== windowDefinitions.length) {
    throw new Error("Invalid CLP usage response");
  }
  const windows = windowDefinitions.map(({ type, windowId, label }): ProviderQuotaWindow => {
    const matches = limits.map(record).filter(limit => limit.type === type);
    if (matches.length !== 1) throw new Error("Missing or duplicate CLP window");
    const { percentUsed, resetsAt } = matches[0]!;
    if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed) || percentUsed < 0) {
      throw new Error("Invalid CLP percentage");
    }
    // The upstream uses RFC 3339 UTC timestamps with fractional seconds.
    const resetMs = typeof resetsAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(resetsAt)
      ? Date.parse(resetsAt) : NaN;
    if (!Number.isFinite(resetMs) || resetMs <= 0 || new Date(resetMs).toISOString().slice(0, 19) !== String(resetsAt).slice(0, 19)) throw new Error("Invalid CLP reset time");
    return { windowId, label, usedPercent: percentUsed, resetsAt: Math.floor(resetMs / 1_000), status: null };
  });
  return { kind: "quota-windows", provider, available: true, windows };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid CLP response object");
  return value as Record<string, unknown>;
}
