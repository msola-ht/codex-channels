import { loadOpencodeGoAccountCredential } from "../../runtime/model-provider-runtime.mjs";
import { readBoundedFetchBody } from "./bounded-fetch-body.js";

import type {
  ProviderAccountAdapter,
  ProviderAccountUsage,
  ProviderQuotaWindow,
} from "../application/index.js";
import { UserFacingError } from "../conversation-core/index.js";

const opencodeGoUsageUrl = "https://opencode.ai/zen/go/v1/usage";
const maximumResponseBytes = 65_536;
const requestTimeoutMs = 10_000;

const windowLabels: Readonly<Record<string, string>> = Object.freeze({
  rolling: "5小时",
  weekly: "7天",
  monthly: "月度",
});

export function createOpencodeGoAccountAdapter(
  options: OpencodeGoAccountAdapterOptions = {},
): ProviderAccountAdapter {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: "opencode-go",
    async accountUsage() {
      try {
        const apiKey = loadOpencodeGoAccountCredential(environment);
        const response = await fetchImpl(opencodeGoUsageUrl, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`OpenCode Go usage request failed with status ${response.status}`);
        }
        const body = await readBoundedFetchBody(response, maximumResponseBytes, {
          invalidContentLength: () => new Error("OpenCode Go usage response length is invalid"),
          tooLarge: () => new Error("OpenCode Go usage response is too large"),
          missingBody: () => new Error("OpenCode Go usage response is empty"),
        });
        return parseUsageResponse(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        throw new UserFacingError(
          "provider.account.unavailable",
          "OpenCode Go 账户查询失败",
          { provider: "OpenCode Go" },
        );
      }
    },
  };
}

export interface OpencodeGoAccountAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function parseUsageResponse(value: unknown): ProviderAccountUsage {
  const response = record(value);
  if (
    response.usage === null
    || typeof response.usage !== "object"
    || Array.isArray(response.usage)
  ) {
    throw new Error("OpenCode Go usage response schema is invalid");
  }
  const usage = record(response.usage);
  const windows = Object.entries(usage).flatMap(([windowId, raw]) => {
    const window = record(raw);
    if (
      typeof window.percent !== "number"
      || !Number.isFinite(window.percent)
      || window.percent < 0
      || window.percent > 100
    ) {
      return [];
    }
    const windowResult: ProviderQuotaWindow = {
      windowId,
      label: windowLabels[windowId] ?? windowId,
      usedPercent: window.percent,
      resetsAt: null,
      status: typeof window.status === "string" ? window.status : null,
    };
    if (typeof window.resetsAt === "string") {
      const resetsAt = Date.parse(window.resetsAt);
      if (Number.isFinite(resetsAt)) {
        windowResult.resetsAt = Math.floor(resetsAt / 1_000);
      }
    }
    return [windowResult];
  });
  if (windows.length === 0) {
    throw new Error("OpenCode Go usage response has no valid windows");
  }
  return {
    kind: "quota-windows",
    provider: "opencode-go",
    available: true,
    windows,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
