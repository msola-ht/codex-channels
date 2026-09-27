import type { AccountRefreshReason } from "../../runtime/gateway-account-refresh.mjs";
import { UserFacingError } from "../conversation-core/index.js";
import { readBoundedFetchBody } from "./bounded-fetch-body.js";

export type AccountQueryReason = AccountRefreshReason;
type Stage = "configuration" | "request" | "response" | "parse" | "local";

class HttpFailure extends Error {
  constructor(readonly status: number) { super("Account HTTP failure"); }
}

export class AccountQueryError extends UserFacingError {
  constructor(provider: string, readonly diagnostic: {
    reason: AccountQueryReason; stage: Stage; operation: string; elapsedMs: number;
    httpStatus?: number; networkCode?: string;
  }, cause: unknown) {
    super("provider.account.unavailable", `${provider} 账户查询失败`, { provider, reason: diagnostic.reason }, { cause });
  }
}

/** One budget across credential loading, requests, body reads and parsing. */
export class AccountQuery {
  readonly signal: AbortSignal;
  stage: Stage = "configuration";
  operation = "credentials";
  private readonly started = performance.now();

  constructor(private readonly provider: string, private readonly caller?: AbortSignal) {
    this.signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(caller ? [caller] : [])]);
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      this.signal.throwIfAborted();
      const result = await action();
      this.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (this.caller?.aborted) throw this.caller.reason;
      const networkCode = safeNetworkCode(error);
      const reason: AccountQueryReason = this.signal.aborted ? "timeout"
        : error instanceof HttpFailure ? httpReason(error.status)
        : this.stage === "configuration" ? "configuration"
        : this.stage === "local" ? "internal"
        : this.stage === "request" || networkCode !== undefined ? "network"
        : "invalid-response";
      throw new AccountQueryError(this.provider, {
        reason, stage: this.stage, operation: this.operation,
        elapsedMs: Math.round(performance.now() - this.started),
        ...(error instanceof HttpFailure ? { httpStatus: error.status } : {}),
        ...(networkCode ? { networkCode } : {}),
      }, error);
    }
  }

  async json(fetchImpl: typeof fetch, url: string, apiKey: string, operation: string,
    options: { allowForbidden?: boolean; redirect?: RequestRedirect } = {},
  ): Promise<{ body: unknown; status: number }> {
    this.operation = operation;
    this.stage = "request";
    this.signal.throwIfAborted();
    const response = await fetchImpl(url, {
      method: "GET", headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: this.signal, ...(options.redirect ? { redirect: options.redirect } : {}),
    });
    this.signal.throwIfAborted();
    if (!response.ok && !(options.allowForbidden && response.status === 403)) {
      void response.body?.cancel().catch(() => undefined);
      this.rejectHttp(response.status);
    }
    this.stage = "response";
    const body = await readBoundedFetchBody(response, 65_536, {
      invalidContentLength: () => new Error("Invalid account response length"),
      tooLarge: () => new Error("Account response too large"),
      missingBody: () => new Error("Missing account response"),
    });
    this.signal.throwIfAborted();
    this.stage = "parse";
    return { body: JSON.parse(body.toString("utf8")) as unknown, status: response.status };
  }

  rejectHttp(status: number): never { throw new HttpFailure(status); }
}

function httpReason(status: number): AccountQueryReason {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limited";
  return "upstream";
}

function safeNetworkCode(error: unknown): string | undefined {
  const allowed = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && allowed.has(code)) return code;
    current = current.cause;
  }
  return undefined;
}

/** Only explicit, bounded fields may cross into diagnostics. */
export function accountQueryFailureMetadata(error: unknown, elapsedMs: number) {
  return error instanceof AccountQueryError ? error.diagnostic
    : { reason: "internal" as const, stage: "refresh" as const, elapsedMs: Math.round(elapsedMs) };
}
