const API_ORIGIN = "https://api.bot.qq.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type QqProtocolOperation = "token" | "gateway";
export type QqProtocolFailure =
  | "invalid-input" | "closed" | "cancelled" | "timeout" | "network"
  | "http" | "business" | "invalid-response" | "response-too-large";

/** Contains local classifications only; upstream text and credentials never escape. */
export class QqProtocolError extends Error {
  constructor(
    readonly operation: QqProtocolOperation,
    readonly reason: QqProtocolFailure,
    readonly httpStatus?: number,
    readonly bizCode?: number,
    readonly traceId?: string,
  ) {
    super(`QQ ${operation}: ${reason}`);
    this.name = "QqProtocolError";
  }
}

export interface QqProtocolClientOptions {
  appId: string;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/** One immutable account/credential generation. Replace the client on configuration changes. */
export class QqProtocolClient {
  private readonly lifetime = new AbortController();
  private cachedToken: { value: string; expiresAt: number } | undefined;
  private tokenFlight: Promise<string> | undefined;
  private generation = 0;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QqProtocolClientOptions) {
    if (!/^[0-9]+$/u.test(options.appId)
      || options.appSecret.length === 0 || /\s/u.test(options.appSecret)
      || [...options.appSecret].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      })) {
      throw new QqProtocolError("token", "invalid-input");
    }
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.fetchImpl = options.fetchImpl;
  }

  close(): void {
    this.generation++;
    this.cachedToken = undefined;
    this.lifetime.abort();
  }

  invalidateAccessToken(): void {
    this.generation++;
    this.cachedToken = undefined;
  }

  async getAccessToken(signal?: AbortSignal, minimumRemainingMs = 60_000): Promise<string> {
    this.ensureOpen("token", signal);
    const cached = this.cachedToken;
    if (cached && cached.expiresAt - Date.now() > minimumRemainingMs) return cached.value;
    if (!this.tokenFlight) {
      const generation = this.generation;
      const startedAt = Date.now();
      const flight = this.requestJson("token", "/app/getAppAccessToken", {
        appId: this.appId,
        clientSecret: this.appSecret,
      }).then((data) => {
        const expiresIn = typeof data.expires_in === "string"
          && /^[1-9][0-9]{0,3}$/.test(data.expires_in)
          ? Number(data.expires_in) : data.expires_in;
        if (typeof data.access_token !== "string"
          || !/^[\x21-\x7e]{1,4096}$/.test(data.access_token)
          || typeof expiresIn !== "number" || !Number.isInteger(expiresIn)
          || expiresIn <= 0 || expiresIn > 7200) {
          throw new QqProtocolError("token", "invalid-response");
        }
        this.ensureOpen("token");
        if (generation !== this.generation) {
          throw new QqProtocolError("token", "cancelled");
        }
        this.cachedToken = { value: data.access_token, expiresAt: startedAt + expiresIn * 1000 };
        return data.access_token;
      });
      this.tokenFlight = flight;
      void flight.finally(() => {
        if (this.tokenFlight === flight) this.tokenFlight = undefined;
      }).catch(() => undefined);
    }
    // A cancelled caller leaves the bounded, account-owned refresh available to other callers.
    const token = await abortable(this.tokenFlight, signal, "token");
    this.ensureOpen("token", signal);
    if (this.cachedToken?.value !== token || this.cachedToken.expiresAt - Date.now() <= minimumRemainingMs) {
      throw new QqProtocolError("token", "timeout");
    }
    return token;
  }

  async getGatewayUrl(signal?: AbortSignal): Promise<string> {
    return await this.withRequest("gateway", signal, async (requestSignal) => {
      const token = await this.getAccessToken(requestSignal);
      const data = await this.requestJson("gateway", "/gateway", undefined, requestSignal, token);
      if (typeof data.url !== "string" || data.url.length > 2048) {
        throw new QqProtocolError("gateway", "invalid-response");
      }
      let url: URL;
      try { url = new URL(data.url); } catch {
        throw new QqProtocolError("gateway", "invalid-response");
      }
      // Discovery is authenticated against the fixed official API; no caller-supplied endpoint.
      if (url.protocol !== "wss:" || url.username || url.password || url.hash
        || (url.port && url.port !== "443")) {
        throw new QqProtocolError("gateway", "invalid-response");
      }
      return url.href;
    });
  }

  private ensureOpen(operation: QqProtocolOperation, signal?: AbortSignal): void {
    if (this.lifetime.signal.aborted) throw new QqProtocolError(operation, "closed");
    if (signal?.aborted) throw new QqProtocolError(operation, "cancelled");
  }

  private async withRequest<T>(
    operation: QqProtocolOperation,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.ensureOpen(operation, signal);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    const combined = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    try {
      return await abortable(work(combined), combined, operation);
    } catch (error) {
      if (this.lifetime.signal.aborted) throw new QqProtocolError(operation, "closed");
      if (signal?.aborted) throw new QqProtocolError(operation, "cancelled");
      if (deadline.signal.aborted) throw new QqProtocolError(operation, "timeout");
      if (error instanceof QqProtocolError) throw error;
      throw new QqProtocolError(operation, "network");
    } finally {
      clearTimeout(timeout);
      deadline.abort();
    }
  }

  private async requestJson(
    operation: QqProtocolOperation,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    token?: string,
  ): Promise<Record<string, unknown>> {
    return await this.withRequest(operation, signal, async (requestSignal) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `QQBot ${token}`;
      const response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: requestSignal,
        redirect: "error",
      });
      const traceId = safeTraceId(response.headers.get("x-tps-trace-id"));
      if (response.status !== 200 || response.redirected) {
        let code: number | undefined;
        let responseTrace: string | undefined;
        if (!response.redirected && response.body) {
          try {
            const failure: unknown = JSON.parse(await readBody(response, requestSignal, operation));
            if (record(failure)) {
              const candidate = failure.code ?? failure.err_code;
              if (typeof candidate === "number" && Number.isSafeInteger(candidate)) code = candidate;
              responseTrace = safeTraceId(failure.trace_id);
            }
          } catch { /* Malformed error bodies never replace the known HTTP failure. */ }
        } else void response.body?.cancel().catch(() => undefined);
        throw new QqProtocolError(operation, "http", response.status, code, traceId ?? responseTrace);
      }
      const raw = await readBody(response, requestSignal, operation);
      let data: unknown;
      try { data = JSON.parse(raw); } catch {
        throw new QqProtocolError(operation, "invalid-response", response.status, undefined, traceId);
      }
      if (!record(data)) throw new QqProtocolError(operation, "invalid-response", response.status);
      for (const key of ["code", "err_code"]) {
        if (!(key in data)) continue;
        const code = data[key];
        if (typeof code !== "number" || !Number.isSafeInteger(code)) {
          throw new QqProtocolError(operation, "invalid-response", response.status, undefined, traceId);
        }
        if (code !== 0) {
          throw new QqProtocolError(operation, "business", response.status, code,
            traceId ?? safeTraceId(data.trace_id));
        }
      }
      requestSignal.throwIfAborted();
      return data;
    });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

async function readBody(response: Response, signal: AbortSignal, operation: QqProtocolOperation): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new QqProtocolError(operation, "response-too-large");
  }
  if (!response.body) throw new QqProtocolError(operation, "invalid-response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
        catch { throw new QqProtocolError(operation, "invalid-response"); }
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        cancel();
        throw new QqProtocolError(operation, "response-too-large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, operation: QqProtocolOperation): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) {
    // Work may synchronously abort while creating this promise. Consume its later rejection
    // even though cancellation must return immediately instead of waiting for that work.
    void promise.catch(() => {});
    throw new QqProtocolError(operation, "cancelled");
  }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new QqProtocolError(operation, "cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
