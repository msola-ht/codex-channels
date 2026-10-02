import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { ChatToResponses, ModelConversionError, responsesToChat } from "../model-api/index.js";
import { ChatDiagnostics, ChatDiagnosticsChannel, chatDiagnosticsHeader } from "./chat-diagnostics.js";
import { ChatUpstreamError, chatStreamError, chatUpstreamError, readChatHttpError } from "./chat-errors.js";
import type { ProviderProxyOptions } from "./proxy.js";
import { readChatBody, readChatFrames, waitForChatOperation, writeChatData } from "./chat-io.js";
import { pinClinePassRouting } from "./cline-pass-routing.js";

/**
 * 桥负责单次请求预算；外层代理额外保留终态发送时间，避免先截断结构化错误。
 */
export const chatBridgeRequestTimeoutMs = 300_000;
const bridgeTerminalGraceMs = 5_000;

/** HTTP lifecycle adapter. Pure model conversion lives in model-api. */
export class ChatCompletionsBridge {
  readonly diagnostics = new ChatDiagnosticsChannel();
  private readonly active = new Set<AbortController>();
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private readonly requestTimeoutMs: number;
  constructor(private readonly options: ProviderProxyOptions & { clinePass?: boolean }) {
    this.requestTimeoutMs = options.timeoutMs ?? chatBridgeRequestTimeoutMs;
  }
  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
  }
  address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Chat bridge is not listening");
    return `127.0.0.1:${address.port}`;
  }
  /** 面向本桥的统计代理上游参数；空闲超时额外预留终态发送时间。 */
  proxyOptions(): ProviderProxyOptions {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Chat bridge is not listening");
    return {
      upstreamHost: "127.0.0.1",
      upstreamPort: address.port,
      upstreamProtocol: "http",
      chatDiagnostics: this.diagnostics,
      timeoutMs: this.requestTimeoutMs + bridgeTerminalGraceMs,
    };
  }
  async close(): Promise<void> {
    for (const controller of this.active) controller.abort();
    this.server.closeAllConnections();
    this.diagnostics.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/responses") {
      response.writeHead(404).end(); return;
    }
    const controller = new AbortController();
    this.active.add(controller);
    let receivingBody = true;
    let status = 400;
    const timer = setTimeout(() => {
      if (receivingBody) status = 408;
      controller.abort(receivingBody
        ? new ChatUpstreamError("request_timeout", "请求正文接收超时，请重试。", true)
        : chatUpstreamError({ code: "upstream_timeout" }));
    }, this.requestTimeoutMs);
    const abort = (): void => { controller.abort(); };
    response.once("close", abort);
    const diagnostics = new ChatDiagnostics();
    const publishDiagnostics = (): void => this.diagnostics.publish(request.headers[chatDiagnosticsHeader], diagnostics.snapshot());
    try {
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new ModelConversionError("Compressed model requests are unsupported");
      const payloadBody = await readChatBody(request, controller.signal, 16 * 1024 * 1024);
      receivingBody = false;
      const { request: body, toolNames } = responsesToChat(JSON.parse(payloadBody) as unknown);
      status = 502;
      const upstream = this.options.resolveUpstream
        ? await waitForChatOperation(Promise.resolve(this.options.resolveUpstream(request.headers)), controller.signal)
        : { host: this.options.upstreamHost, port: this.options.upstreamPort, protocol: this.options.upstreamProtocol, basePath: this.options.upstreamBasePath, agent: this.options.upstreamAgent };
      if (controller.signal.aborted) throw new Error("aborted");
      const payload = JSON.stringify(this.options.clinePass ? pinClinePassRouting(body) : body);
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", "content-length": String(Buffer.byteLength(payload)) };
      if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
      if (this.options.upstreamUserAgent) headers["user-agent"] = this.options.upstreamUserAgent;
      const upstreamRequest = (upstream.protocol === "http" ? httpRequest : httpsRequest)({
        hostname: upstream.host, port: upstream.port, agent: upstream.agent,
        path: `${upstream.basePath?.replace(/\/$/u, "") ?? ""}/chat/completions`,
        method: "POST", headers, signal: controller.signal,
      });
      const ready = once(upstreamRequest, "response");
      upstreamRequest.end(payload);
      const [incoming] = await ready as [IncomingMessage];
      diagnostics.header(incoming.headers["x-request-id"]);
      diagnostics.responseStatus(incoming.statusCode);
      publishDiagnostics();
      if (incoming.statusCode !== 200) {
        status = incoming.statusCode && incoming.statusCode >= 400 ? incoming.statusCode : 502;
        throw await readChatHttpError(incoming);
      }
      if (!incoming.headers["content-type"]?.startsWith("text/event-stream")) {
        // 200 但不是 SSE：上游没有按流式合同返回，按服务异常归类且不读取正文。
        incoming.destroy();
        throw chatUpstreamError({ code: "server_error" });
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const converter = new ChatToResponses(`resp_${randomUUID()}`, body.model, toolNames);
      const emit = async (events: Record<string, unknown>[]): Promise<void> => {
        for (const event of events) {
          if (controller.signal.aborted) throw new Error("aborted");
          await writeChatData(response, `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`, controller.signal);
        }
      };
      await emit(converter.start());
      let done = false;
      for await (const data of readChatFrames(incoming, controller.signal, {
        frameBytes: Infinity, bufferBytes: Infinity, totalBytes: Infinity, bufferCharacters: 2 * 1024 * 1024,
      })) {
        if (data === "[DONE]") { done = true; break; }
        const chunk: unknown = JSON.parse(data);
        diagnostics.push(chunk);
        const upstreamError = chatStreamError(chunk);
        if (upstreamError) throw upstreamError;
        await emit(converter.push(chunk));
      }
      if (!done) throw new ModelConversionError("Chat stream disconnected before DONE");
      const terminal = converter.finish();
      publishDiagnostics();
      await emit(terminal);
      response.end();
    } catch (error) {
      // 桥自身超时通过中止原因传递，与上游返回的错误使用同一套分类。
      const aborted = controller.signal.reason instanceof ChatUpstreamError ? controller.signal.reason : undefined;
      const failure = error instanceof ModelConversionError || error instanceof ChatUpstreamError ? error : aborted;
      const message = failure?.message ?? "Chat upstream request failed";
      if (status === 502 && (!controller.signal.aborted || aborted)) this.options.onError?.(new Error(message));
      const detail = { code: failure instanceof ChatUpstreamError ? failure.code : status === 400 ? "invalid_request_error" : "chat_upstream_error", message };
      if (failure instanceof ChatUpstreamError) diagnostics.error(failure.code, response.headersSent ? "stream" : "http", failure.retryable);
      publishDiagnostics();
      if (!response.destroyed) {
        if (response.headersSent) {
          response.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: detail } })}\n\n`);
        } else {
          // 未读完的正文不能复用连接；先送达错误，再释放入站请求。
          if (!request.complete) {
            response.setHeader("connection", "close");
            response.once("finish", () => request.destroy());
          }
          response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: detail }));
        }
      }
    } finally {
      clearTimeout(timer); response.off("close", abort); controller.abort(); this.active.delete(controller);
    }
  }
}
