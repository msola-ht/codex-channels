import type { IncomingHttpHeaders } from "node:http";

const openAiPostPaths = new Set([
  "/alpha/search",
  "/images/edits",
  "/images/generations",
  "/live",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

export function parseListenAddress(value: string): { host: string; port: number } {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`代理监听地址无效：${value}`);
  }
  const host = value.slice(0, separatorIndex);
  const port = Number(value.slice(separatorIndex + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`代理监听端口无效：${value}`);
  }
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(`代理监听地址必须为回环地址：${value}`);
  }
  return { host, port };
}

export function resolveAccountPath(
  value: string | undefined,
  accounts: readonly string[] | undefined,
  defaultAccountId: string | undefined,
): { accountId?: string; path: string } | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value, "http://127.0.0.1");
  } catch {
    return undefined;
  }
  const pathname = url.pathname;
  if (pathname === "/go" || pathname.startsWith("/go/")) {
    const segments = pathname.split("/");
    const accountId = segments[2];
    if (
      accountId === undefined
      || accountId.length === 0
      || !accounts?.includes(accountId)
    ) {
      return undefined;
    }
    const rest = `/${segments.slice(3).join("/")}`;
    return {
      accountId,
      path: `${rest === "/" ? "" : rest}${url.search}`,
    };
  }
  return {
    ...(defaultAccountId === undefined ? {} : { accountId: defaultAccountId }),
    path: `${pathname}${url.search}`,
  };
}

export function isSupportedHttpRequest(
  method: string | undefined,
  value: string | undefined,
  allowOpenAiApiPaths: boolean,
): boolean {
  if (!value) return false;
  try {
    const path = new URL(value, "http://127.0.0.1").pathname;
    if (path === "/models") return method === "GET";
    if (allowOpenAiApiPaths && openAiPostPaths.has(path)) return method === "POST";
    return path === "/responses" || path === "/responses/compact";
  } catch {
    return false;
  }
}

export function isResponsesPath(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value, "http://127.0.0.1").pathname === "/responses";
  } catch {
    return false;
  }
}

export function isOpenAiRealtimeWebSocketPath(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const path = new URL(value, "http://127.0.0.1").pathname;
    return path === "/v1/realtime"
      || path === "/v1/live"
      || /^\/v1\/live\/[a-zA-Z0-9_-]{1,128}$/u.test(path);
  } catch {
    return false;
  }
}

export function isResponsesRequestPath(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const path = new URL(value, "http://127.0.0.1").pathname;
    return path === "/responses" || path === "/responses/compact";
  } catch {
    return false;
  }
}

export function responseOperation(
  value: string | undefined,
  metadataOperation: "response" | "compact",
): "response" | "compact" {
  if (!value) return metadataOperation;
  try {
    return new URL(value, "http://127.0.0.1").pathname === "/responses/compact"
      ? "compact"
      : metadataOperation;
  } catch {
    return metadataOperation;
  }
}

export function upstreamPath(
  basePath: string | undefined,
  requestPath: string | undefined,
): string {
  const source = new URL(requestPath ?? "/", "http://127.0.0.1");
  const prefix = basePath?.replace(/\/$/u, "") ?? "";
  return `${prefix}${source.pathname}${source.search}`;
}

export function upstreamWebSocketPath(
  basePath: string | undefined,
  requestPath: string | undefined,
  recordsResponseMetrics: boolean,
): string {
  if (recordsResponseMetrics) return upstreamPath(basePath, requestPath);
  const source = new URL(requestPath ?? "/", "http://127.0.0.1");
  source.pathname = source.pathname.replace(/^\/v1(?=\/)/u, "");
  return upstreamPath(basePath, `${source.pathname}${source.search}`);
}

export function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
  upstreamPort: number | undefined,
): IncomingHttpHeaders {
  const forwarded = endToEndHeaders(headers);
  delete forwarded["x-codex-turn-metadata"];
  forwarded.host = upstreamPort === undefined ? upstreamHost : `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

export function forwardedWebSocketHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
  upstreamPort: number | undefined,
): IncomingHttpHeaders {
  const forwarded = endToEndHeaders(headers);
  for (const name of [
    "host",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "x-codex-turn-metadata",
  ]) delete forwarded[name];
  forwarded.host = upstreamPort === undefined ? upstreamHost : `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

export function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionTokens = typeof headers.connection === "string"
    ? headers.connection.split(",").map((value) => value.trim().toLowerCase())
    : [];
  for (const name of [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", ...connectionTokens,
  ]) delete result[name];
  return result;
}

export function websocketProtocols(
  value: string | string[] | undefined,
): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const protocols = value.split(",").map((item) => item.trim()).filter(Boolean);
  return protocols.length === 0 ? undefined : protocols;
}
