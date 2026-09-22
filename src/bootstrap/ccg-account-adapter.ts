import { isCcgAccountProvider } from "../../runtime/ccg-accounts.mjs";
import { loadConfiguredProviderCredential } from "../../runtime/model-provider-runtime.mjs";
import type { ManagedModelProviderId } from "../../runtime/model-provider-definitions.mjs";
import { readBoundedFetchBody } from "./bounded-fetch-body.js";

import type {
  ProviderAccountAdapter,
  ProviderAccountUsage,
  ProviderQuotaWindow,
} from "../application/index.js";
import { UserFacingError } from "../conversation-core/index.js";

const commandCodeApiBaseUrl = "https://api.commandcode.ai";
const maximumResponseBytes = 65_536;
const requestTimeoutMs = 10_000;

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
    async accountUsage() {
      try {
        const apiKey = loadConfiguredProviderCredential(options.provider, environment).apiKey;
        const whoami = await getJson(fetchImpl, `${commandCodeApiBaseUrl}/alpha/whoami?limits=1`, apiKey);
        const orgId = optionalIdentifier(record(whoami).org, "id");
        const query = orgId === null ? "" : `?orgId=${encodeURIComponent(orgId)}`;
        const credits = await getJson(
          fetchImpl,
          `${commandCodeApiBaseUrl}/alpha/billing/credits${query}`,
          apiKey,
        );
        return parseCreditUsage(credits, options.provider);
      } catch {
        throw new UserFacingError(
          "provider.account.unavailable",
          "CCG 账户查询失败",
          { provider: "CCG" },
        );
      }
    },
  };
}

async function getJson(fetchImpl: typeof fetch, url: string, apiKey: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`CCG account request failed with status ${response.status}`);
  const body = await readBoundedFetchBody(response, maximumResponseBytes, {
    invalidContentLength: () => new Error("CCG account response length is invalid"),
    tooLarge: () => new Error("CCG account response is too large"),
    missingBody: () => new Error("CCG account response is empty"),
  });
  return JSON.parse(body.toString("utf8")) as unknown;
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
    monthlyRemaining,
    purchasedRemaining,
    freeRemaining,
    totalRemaining: credit(
      Number(monthlyRemaining) + Number(purchasedRemaining) + Number(freeRemaining),
    ),
    windows,
  };
}

function parseWindows(value: unknown): ProviderQuotaWindow[] {
  const limits = record(value);
  if (limits.limited !== true) return [];
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

function optionalIdentifier(value: unknown, key: string): string | null {
  const candidate = record(value)[key];
  return candidate === undefined || candidate === null ? null : requiredString(candidate);
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

function optionalCredit(value: unknown): string {
  return value === undefined || value === null ? "0.00" : credit(value);
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
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
