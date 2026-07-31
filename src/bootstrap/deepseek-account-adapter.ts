import { loadDeepseekAccountCredential } from "../../runtime/model-provider-runtime.mjs";

import type {
  ProviderAccountAdapter,
  ProviderAccountUsage,
  ProviderBalance,
} from "../application/index.js";
import { UserFacingError } from "../conversation-core/index.js";

const deepseekBalanceUrl = "https://api.deepseek.com/user/balance";
const maximumResponseBytes = 65_536;
const requestTimeoutMs = 10_000;

export function createDeepseekAccountAdapter(
  options: DeepseekAccountAdapterOptions = {},
): ProviderAccountAdapter {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider: "deepseek",
    async accountUsage() {
      try {
        const apiKey = loadDeepseekAccountCredential(environment);
        const response = await fetchImpl(deepseekBalanceUrl, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`DeepSeek balance request failed with status ${response.status}`);
        }
        return parseBalanceResponse(await readBoundedJson(response));
      } catch {
        throw new UserFacingError(
          "provider.account.unavailable",
          "DeepSeek 账户查询失败",
          { provider: "DeepSeek" },
        );
      }
    },
  };
}

export interface DeepseekAccountAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumResponseBytes) {
      throw new Error("DeepSeek balance response length is invalid");
    }
  }
  if (!response.body) {
    throw new Error("DeepSeek balance response is empty");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel();
        throw new Error("DeepSeek balance response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length)
    .toString("utf8");
  return JSON.parse(body) as unknown;
}

function parseBalanceResponse(value: unknown): ProviderAccountUsage {
  const response = record(value);
  if (typeof response.is_available !== "boolean" || !Array.isArray(response.balance_infos)) {
    throw new Error("DeepSeek balance response schema is invalid");
  }
  if (response.balance_infos.length > 4) {
    throw new Error("DeepSeek balance response has too many currencies");
  }
  return {
    kind: "balance",
    provider: "deepseek",
    available: response.is_available,
    balances: response.balance_infos.map(parseBalance),
  };
}

function parseBalance(value: unknown): ProviderBalance {
  const balance = record(value);
  if (balance.currency !== "CNY" && balance.currency !== "USD") {
    throw new Error("DeepSeek balance currency is invalid");
  }
  return {
    currency: balance.currency,
    totalBalance: decimal(balance.total_balance),
    grantedBalance: decimal(balance.granted_balance),
    toppedUpBalance: decimal(balance.topped_up_balance),
  };
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^-?\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error("DeepSeek balance amount is invalid");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
