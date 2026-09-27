import { isCcgAccountProvider } from "../../runtime/ccg-accounts.mjs";
import { loadConfiguredProviderCredential } from "../../runtime/model-provider-runtime.mjs";
import type { ManagedModelProviderId } from "../../runtime/model-provider-definitions.mjs";
import { AccountQuery } from "./account-query.js";

import type {
  ProviderAccountAdapter,
  ProviderAccountUsage,
  ProviderQuotaWindow,
} from "../application/index.js";

const commandCodeApiBaseUrl = "https://api.commandcode.ai";

export interface CcgAccountAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  provider: ManagedModelProviderId;
}

export function createCcgAccountAdapter(
  options: CcgAccountAdapterOptions,
): ProviderAccountAdapter {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!isCcgAccountProvider(options.provider)) {
    throw new Error(`CCG 账户适配器不支持 Provider：${options.provider}`);
  }
  return {
    provider: options.provider,
    async accountUsage(signal) {
      const query = new AccountQuery("CCG", signal);
      return query.run(async () => {
        const apiKey = loadConfiguredProviderCredential(options.provider, environment).apiKey;
        const { body: whoami } = await query.json(fetchImpl, `${commandCodeApiBaseUrl}/alpha/whoami?limits=1`, apiKey, "identity");
        const orgId = parseOrganizationId(whoami);
        const suffix = orgId === null ? "" : `?orgId=${encodeURIComponent(orgId)}`;
        const { body: credits } = await query.json(fetchImpl, `${commandCodeApiBaseUrl}/alpha/billing/credits${suffix}`, apiKey, "credits");
        return parseCreditUsage(credits, options.provider);
      });
    },
  };
}

function parseCreditUsage(
  value: unknown,
  provider: string,
): Extract<ProviderAccountUsage, { kind: "credit-usage" }> {
  const response = record(value);
  const credits = record(response.credits);
  const monthlyRemaining = optionalCredit(credits.monthlyCredits);
  const purchasedRemaining = optionalCredit(credits.purchasedCredits);
  const freeRemaining = optionalCredit(credits.freeCredits);
  const planId = optionalString(credits.planId);
  const windows = parseWindows(response.windowLimits);
  return {
    kind: "credit-usage",
    provider,
    available: true,
    planId,
    monthlyRemaining: credit(monthlyRemaining),
    purchasedRemaining: credit(purchasedRemaining),
    freeRemaining: credit(freeRemaining),
    totalRemaining: credit(monthlyRemaining + purchasedRemaining + freeRemaining),
    windows,
  };
}

function parseWindows(value: unknown): ProviderQuotaWindow[] {
  if (value === undefined || value === null) return [];
  const limits = record(value);
  if (typeof limits.limited !== "boolean") throw new Error("CCG account response limit flag is invalid");
  if (!limits.limited) return [];
  return [
    parseWindow(limits.fiveHour, "five-hour", "5小时"),
    parseWindow(limits.weekly, "weekly", "7天"),
  ].filter((window): window is ProviderQuotaWindow => window !== undefined);
}

function parseWindow(
  value: unknown,
  windowId: string,
  label: string,
): ProviderQuotaWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const window = record(value);
  const used = nonNegativeNumber(window.used);
  const cap = positiveNumber(window.cap);
  const resetAtMs = nonNegativeNumber(window.resetAt);
  return {
    windowId,
    label,
    usedPercent: Math.min(100, used / cap * 100),
    resetsAt: Math.floor(resetAtMs / 1_000),
    status: null,
  };
}

function parseOrganizationId(value: unknown): string | null {
  const response = record(value);
  if (response.success !== true) throw new Error("CCG account identity is unavailable");
  record(response.user);
  return response.org === undefined || response.org === null
    ? null
    : requiredString(record(response.org).id);
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : requiredString(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("CCG account response string is invalid");
  }
  return value;
}

function credit(value: unknown): string {
  const amount = nonNegativeNumber(value);
  return amount.toFixed(2);
}

function optionalCredit(value: unknown): number {
  return value === undefined || value === null ? 0 : nonNegativeNumber(value);
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("CCG account response number is invalid");
  }
  return value;
}

function positiveNumber(value: unknown): number {
  const number = nonNegativeNumber(value);
  if (number === 0) throw new Error("CCG account response limit is invalid");
  return number;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CCG account response object is invalid");
  }
  return value as Record<string, unknown>;
}
