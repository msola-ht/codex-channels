import { once } from "node:events";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { ChatUpstreamError } from "./chat-errors.js";
import { readChatBody } from "./chat-io.js";
import { validateDirectModelResponse } from "./direct-model-http.js";
import type { ProviderProxyUpstream } from "./proxy.js";

export interface ClineWebSearchInput {
  query: string;
  allowedDomains?: string[];
}

export interface ClineWebSearchResult {
  url: string;
  title: string;
}

const invalidResponse = (): ChatUpstreamError => new ChatUpstreamError(
  "clp_search_invalid_response", "CLP 网页搜索返回了无效响应。", false,
);

/** Only standard delay-seconds or canonical HTTP-date, never arbitrary header text. */
function retryAfter(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  if (/^\d+$/u.test(value) && Number.isSafeInteger(Number(value))) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value ? value : undefined;
}

function httpError(incoming: IncomingMessage): ChatUpstreamError {
  const status = incoming.statusCode;
  const delay = status === 429 || status === 503 ? retryAfter(incoming.headers["retry-after"]) : undefined;
  if (status === 401) return new ChatUpstreamError("clp_search_authentication_error", "CLP 网页搜索认证失败，请检查账户凭据。", false, delay, status);
  if (status === 402) return new ChatUpstreamError("clp_search_payment_required", "CLP 网页搜索额度不足，请检查账户余额或套餐。", false, delay, status);
  if (status === 403) return new ChatUpstreamError("clp_search_permission_denied", "CLP 账户无权使用网页搜索。", false, delay, status);
  if (status === 429) return new ChatUpstreamError("clp_search_rate_limit", "CLP 网页搜索受到限流，请稍后重试。", true, delay, status);
  if (status === 408 || status === 504) return new ChatUpstreamError("clp_search_timeout", "CLP 网页搜索超时，请稍后重试。", true, delay, status);
  return new ChatUpstreamError("clp_search_upstream_error", "CLP 网页搜索上游请求失败。", status !== undefined && status >= 500, delay, status);
}

function searchResults(value: unknown): ClineWebSearchResult[] {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("data" in value)) throw invalidResponse();
  const data = value.data;
  if (data === null || typeof data !== "object" || Array.isArray(data) || !("results" in data)
    || !Array.isArray(data.results) || data.results.length > 50) throw invalidResponse();
  return data.results.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !("url" in entry)
      || typeof entry.url !== "string" || entry.url.length === 0 || entry.url.length > 8192
      || entry.url !== entry.url.trim() || [...entry.url].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
      || !/^https?:\/\//iu.test(entry.url)) throw invalidResponse();
    let url: URL;
    try { url = new URL(entry.url); } catch { throw invalidResponse(); }
    if (!url.hostname || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw invalidResponse();
    const title: unknown = "title" in entry ? entry.title : undefined;
    if (title !== undefined && (typeof title !== "string" || title.length > 4096)) throw invalidResponse();
    return { url: entry.url, title: typeof title === "string" && title.trim() ? title : entry.url.slice(0, 4096) };
  });
}

/** One same-origin CLP search exchange. The caller owns input validation and authentication. */
export async function executeClineWebSearch(
  target: ProviderProxyUpstream,
  headers: OutgoingHttpHeaders,
  input: ClineWebSearchInput,
  signal: AbortSignal,
): Promise<ClineWebSearchResult[]> {
  const controller = new AbortController();
  const timeout = new ChatUpstreamError("clp_search_timeout", "CLP 网页搜索超时，请稍后重试。", true);
  const timer = setTimeout(() => controller.abort(timeout), 45_000);
  const operationSignal = AbortSignal.any([signal, controller.signal]);
  let request: ReturnType<typeof httpRequest> | undefined;
  let incoming: IncomingMessage | undefined;
  const abort = (): void => { request?.destroy(); incoming?.destroy(); };
  operationSignal.addEventListener("abort", abort, { once: true });
  try {
    operationSignal.throwIfAborted();
    const payload = JSON.stringify({ query: input.query, ...(input.allowedDomains === undefined ? {} : { allowed_domains: input.allowedDomains }) });
    const outgoing = { ...headers };
    for (const name of Object.keys(outgoing)) {
      if (["content-type", "content-length", "content-encoding", "transfer-encoding", "accept", "accept-encoding", "expect"].includes(name.toLowerCase())) delete outgoing[name];
    }
    Object.assign(outgoing, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
      accept: "application/json", "accept-encoding": "identity" });
    request = (target.protocol === "http" ? httpRequest : httpsRequest)({
      hostname: target.host, port: target.port, agent: target.agent,
      path: `${target.basePath?.replace(/\/$/u, "") ?? ""}/search/websearch`,
      method: "POST", headers: outgoing, signal: operationSignal,
    });
    // A cancellation after response headers can still emit a request error.
    request.on("error", () => undefined);
    const ready = once(request, "response", { signal: operationSignal });
    request.end(payload);
    [incoming] = await ready as [IncomingMessage];
    // HTTP status is authoritative; never consume or expose an arbitrary error body.
    if (incoming.statusCode !== 200) throw httpError(incoming);
    await validateDirectModelResponse(incoming, false);
    const text = await readChatBody(incoming, operationSignal, 256 * 1024);
    let value: unknown;
    try { value = JSON.parse(text) as unknown; } catch { throw invalidResponse(); }
    return searchResults(value);
  } catch (error) {
    if (error instanceof ChatUpstreamError && error.code.startsWith("clp_search_")) throw error;
    if (controller.signal.aborted && operationSignal.reason === timeout) throw timeout;
    if (signal.aborted) throw new ChatUpstreamError("clp_search_cancelled", "CLP 网页搜索已取消。", false);
    if (incoming?.statusCode === 200) throw invalidResponse();
    throw new ChatUpstreamError("clp_search_upstream_error", "CLP 网页搜索上游连接失败。", true);
  } finally {
    clearTimeout(timer);
    operationSignal.removeEventListener("abort", abort);
    incoming?.destroy();
    request?.destroy();
  }
}
