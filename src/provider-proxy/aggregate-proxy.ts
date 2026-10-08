import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { ChatBodyTooLargeError, readChatBody, waitForChatOperation } from "./chat-io.js";
import { endToEndHeaders } from "./request-routing.js";

const maximumBodyBytes = 16 * 1024 * 1024;
const uploadTimeoutMs = 30_000;
const snapshotTimeoutMs = 15_000;
const defaultRouteTimeoutMs = 310_000;
const maximumRouteTimeoutMs = 600_000;
const correlationHeaders = new Set([
  "user-agent", "session-id", "thread-id", "x-request-id", "x-client-request-id",
  "x-codex-turn-metadata", "x-codex-parent-thread-id", "x-responsesapi-include-timing-metrics",
]);

export interface AggregateModelRoute {
  model: string;
  apiKey: string;
  /** Already authorized, running ProviderProxy; never a real upstream URL. */
  baseUrl: string;
  /** Header and stream idle budget; independent of the 600-second response deadline. */
  timeoutMs?: number;
}

export interface AggregateModelProxyOptions {
  token: string;
  routes: ReadonlyMap<string, AggregateModelRoute>;
  /** Revalidate the authorized snapshot before submission; asynchronous checks receive request cancellation. */
  assertCurrent?: (signal: AbortSignal) => void | Promise<void>;
}

interface LocalRoute {
  model: string;
  authorization: string;
  port: number;
  path: string;
  timeoutMs: number;
}

class AggregateRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Stateless HTTP-only model selection over authorized local ProviderProxy routes. */
export class AggregateModelProxy {
  private readonly routes = new Map<string, LocalRoute>();
  private readonly authenticationDigest: Buffer;
  private readonly server;
  private readonly sockets = new Set<Socket>();
  private readonly active = new Set<AbortController>();
  private readonly assertCurrent: ((signal: AbortSignal) => void | Promise<void>) | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private stopped = false;

  constructor(options: AggregateModelProxyOptions) {
    if (!/^[\x21-\x7e]{32,512}$/u.test(options.token)) throw new Error("聚合模型代理需要有效的本地随机认证令牌。");
    this.authenticationDigest = digest(`Bearer ${options.token}`);
    this.assertCurrent = options.assertCurrent;
    for (const [slug, route] of options.routes) {
      if (!/^[a-zA-Z0-9_-]{1,64}\/[^\p{Cc}]{1,200}$/u.test(slug)
        || typeof route.model !== "string" || route.model.length < 1 || route.model.length > 200
        || /\p{Cc}/u.test(route.model) || route.model.trim() !== route.model
        || slug.slice(slug.indexOf("/") + 1) !== route.model
        || !/^[\x21-\x7e]{1,16384}$/u.test(route.apiKey)) throw new Error("聚合模型代理路由无效。");
      const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/go\/[a-zA-Z0-9_-]{1,128})?\/?$/u.exec(route.baseUrl);
      const port = Number(match?.[1]);
      if (!match || port > 65535) throw new Error("聚合模型代理目标必须是已授权的本地 ProviderProxy。");
      const timeoutMs = route.timeoutMs === undefined ? defaultRouteTimeoutMs : route.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumRouteTimeoutMs) {
        throw new Error("聚合模型代理路由超时必须是 1 至 600000 毫秒的整数。");
      }
      this.routes.set(slug, { model: route.model, authorization: `Bearer ${route.apiKey}`, port,
        path: `${match[2] ?? ""}/responses`, timeoutMs });
    }
    if (this.routes.size === 0) throw new Error("聚合模型代理至少需要一个授权模型。");
    this.server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: uploadTimeoutMs, requestTimeout: uploadTimeoutMs }, (request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
    });
    this.server.on("checkContinue", (request, response) => reject(request, response,
      new AggregateRequestError(417, "unsupported_expectation", "聚合模型代理不支持 Expect 请求。")));
    this.server.on("checkExpectation", (request, response) => reject(request, response,
      new AggregateRequestError(417, "unsupported_expectation", "聚合模型代理不支持 Expect 请求。")));
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("聚合模型代理已关闭。"));
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, rejectStart) => {
      const failed = (): void => {
        this.server.off("listening", listening);
        this.starting = undefined;
        rejectStart(new Error("聚合模型代理无法启动。"));
      };
      const listening = (): void => { this.server.off("error", failed); resolve(); };
      this.server.once("error", failed);
      this.server.once("listening", listening);
      this.server.listen(0, "127.0.0.1");
    });
    return this.starting;
  }

  address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string" || this.stopped) throw new Error("聚合模型代理尚未监听。");
    return `127.0.0.1:${address.port}`;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = this.finishClose();
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    await this.starting?.catch(() => undefined);
    for (const controller of this.active) controller.abort(new AggregateRequestError(503, "aggregate_closed", "聚合模型代理已关闭。"));
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    const timeout = (): void => controller.abort(new AggregateRequestError(504, "aggregate_timeout", "聚合模型请求超时。"));
    const disconnected = (): void => { if (!response.writableFinished) controller.abort(); };
    const aborted = (): void => controller.abort();
    let totalTimer = setTimeout(timeout, uploadTimeoutMs + snapshotTimeoutMs + maximumRouteTimeoutMs);
    const uploadTimer = setTimeout(timeout, uploadTimeoutMs);
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let headTimer: ReturnType<typeof setTimeout> | undefined;
    let upstream: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    this.active.add(controller);
    response.once("close", disconnected);
    request.once("aborted", aborted);
    response.setTimeout(uploadTimeoutMs, timeout);
    try {
      if (this.stopped) throw new AggregateRequestError(503, "aggregate_closed", "聚合模型代理已关闭。");
      if (request.method !== "POST" || request.url !== "/responses") throw new AggregateRequestError(404, "unsupported_endpoint", "聚合模型代理仅支持 POST /responses。");
      const authorization = request.headers.authorization;
      const authorizationCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "authorization").length;
      if (authorizationCount !== 1 || typeof authorization !== "string" || !timingSafeEqual(this.authenticationDigest, digest(authorization))) {
        throw new AggregateRequestError(401, "unauthorized", "聚合模型代理认证失败。");
      }
      if (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") {
        throw new AggregateRequestError(415, "unsupported_encoding", "聚合模型代理不支持压缩请求正文。");
      }
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new AggregateRequestError(415, "unsupported_content_type", "聚合模型请求必须使用 application/json。");
      }
      if (Number(request.headers["content-length"]) > maximumBodyBytes) throw new ChatBodyTooLargeError("Aggregate request exceeds size limit");
      const text = await readJsonBody(request, controller);
      clearTimeout(uploadTimer);
      const body = parseBody(text);
      const route = this.routes.get(body.model);
      if (!route) throw new AggregateRequestError(400, "unknown_model", "聚合模型未获授权或不存在。");
      let payload: string;
      try { payload = JSON.stringify({ ...body, model: route.model, store: false }); }
      catch { throw new AggregateRequestError(400, "invalid_payload", "聚合模型请求嵌套结构无效。"); }
      const headers = requestHeaders(request.headers, route.authorization, Buffer.byteLength(payload), body.stream === true);
      signal.throwIfAborted();
      response.setTimeout(snapshotTimeoutMs, timeout);
      snapshotTimer = setTimeout(timeout, snapshotTimeoutMs);
      try {
        const pending = this.assertCurrent?.(signal);
        if (pending !== undefined) await waitForChatOperation(pending, signal);
      } catch {
        signal.throwIfAborted();
        throw new AggregateRequestError(409, "aggregate_snapshot_changed", "模型账户或目录已变更，请等待聚合设置安全应用；Gateway 未运行时需重启 App Server。");
      }
      signal.throwIfAborted();
      clearTimeout(snapshotTimer);
      clearTimeout(totalTimer);
      totalTimer = setTimeout(timeout, maximumRouteTimeoutMs);
      response.setTimeout(route.timeoutMs, timeout);
      upstream = httpRequest({ hostname: "127.0.0.1", port: route.port, path: route.path, method: "POST", headers, signal, agent: false });
      upstream.setTimeout(route.timeoutMs, timeout);
      headTimer = setTimeout(timeout, route.timeoutMs);
      const ready = once(upstream, "response", { signal });
      upstream.end(payload);
      [incoming] = await ready as [IncomingMessage];
      clearTimeout(headTimer);
      signal.throwIfAborted();
      response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
      response.flushHeaders();
      await pipeline(incoming, response, { signal });
    } catch (error) {
      const failure = signal.reason instanceof AggregateRequestError ? signal.reason
        : error instanceof AggregateRequestError ? error
        : error instanceof ChatBodyTooLargeError ? new AggregateRequestError(413, "body_too_large", "聚合模型请求正文超过 16 MiB。")
        : new AggregateRequestError(502, "local_proxy_failed", "本地模型代理连接失败或响应中断。");
      if (!response.destroyed && !response.headersSent) reject(request, response, failure);
      else if (!response.writableFinished) response.destroy();
    } finally {
      clearTimeout(totalTimer); clearTimeout(uploadTimer); clearTimeout(snapshotTimer); clearTimeout(headTimer);
      upstream?.destroy();
      if (incoming && !incoming.complete) incoming.destroy();
      response.setTimeout(0);
      response.off("close", disconnected); request.off("aborted", aborted);
      this.active.delete(controller);
    }
  }
}

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }

async function readJsonBody(request: IncomingMessage, controller: AbortController): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validate = (chunk?: Buffer): void => {
    try { decoder.decode(chunk, { stream: chunk !== undefined }); }
    catch { controller.abort(new AggregateRequestError(400, "invalid_payload", "聚合模型请求包含无效 UTF-8。")); }
  };
  const ended = (): void => validate();
  request.on("data", validate); request.once("end", ended);
  try { return await readChatBody(request, controller.signal, maximumBodyBytes); }
  finally { request.off("data", validate); request.off("end", ended); }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function parseBody(text: string): Record<string, unknown> & { model: string } {
  let body: unknown;
  try { body = JSON.parse(text) as unknown; }
  catch { throw new AggregateRequestError(400, "invalid_payload", "聚合模型请求包含无效 JSON。"); }
  if (!record(body) || typeof body.model !== "string" || body.model.length === 0
    || !(typeof body.input === "string" || Array.isArray(body.input) && body.input.every(record))
    || body.stream !== undefined && typeof body.stream !== "boolean"
    || body.store !== undefined && typeof body.store !== "boolean"
    || body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.every(record))) {
    throw new AggregateRequestError(400, "invalid_payload", "聚合模型请求结构无效。");
  }
  if ([body.previous_response_id, body.conversation].some(value => value !== undefined && value !== null && value !== "")) {
    throw new AggregateRequestError(400, "unsupported_state", "聚合模型请求不支持 previous_response_id 或 conversation 状态。");
  }
  return { ...body, model: body.model };
}

function requestHeaders(source: IncomingHttpHeaders, authorization: string, length: number, stream: boolean): IncomingHttpHeaders {
  const headers = endToEndHeaders(source);
  for (const name of Object.keys(headers)) if (!correlationHeaders.has(name)) delete headers[name];
  return { ...headers, authorization, "content-type": "application/json", "content-length": String(length),
    "accept-encoding": "identity", accept: stream ? "text/event-stream" : "application/json" };
}

function responseHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = endToEndHeaders(source);
  for (const name of ["authorization", "proxy-authorization", "set-cookie", "cookie", "x-api-key", "api-key"]) delete headers[name];
  return headers;
}

function reject(request: IncomingMessage, response: ServerResponse, error: AggregateRequestError): void {
  request.pause();
  const body = JSON.stringify({ error: { type: error.status >= 500 ? "server_error" : "invalid_request_error", code: error.code, message: error.message } });
  response.writeHead(error.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), connection: "close" });
  response.end(body);
}
