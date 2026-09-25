import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { StringDecoder } from "node:string_decoder";
import { ChatToResponses, ModelConversionError, responsesToChat } from "../model-api/index.js";
import { ChatDiagnostics, ChatDiagnosticsChannel, chatDiagnosticsHeader } from "./chat-diagnostics.js";
import { ChatUpstreamError, chatStreamError, readChatHttpError } from "./chat-errors.js";
import type { ProviderProxyOptions } from "./proxy.js";

/** HTTP lifecycle adapter. Pure model conversion lives in model-api. */
export class ChatCompletionsBridge {
  readonly diagnostics = new ChatDiagnosticsChannel();
  private readonly active = new Set<AbortController>();
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  constructor(private readonly options: ProviderProxyOptions) {}
  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
  }
  address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Chat bridge is not listening");
    return `127.0.0.1:${address.port}`;
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
    const timer = setTimeout(() => {
      controller.abort(); request.destroy(); response.destroy();
    }, this.options.timeoutMs ?? 300_000);
    const abort = (): void => { controller.abort(); };
    response.once("close", abort);
    let status = 400;
    const diagnostics = new ChatDiagnostics();
    const publishDiagnostics = (): void => this.diagnostics.publish(request.headers[chatDiagnosticsHeader], diagnostics.snapshot());
    try {
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new ModelConversionError("Compressed model requests are unsupported");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new ModelConversionError("Model request exceeds size limit");
        chunks.push(chunk);
      }
      const { request: body, toolNames } = responsesToChat(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      status = 502;
      const upstream = this.options.resolveUpstream
        ? await this.options.resolveUpstream(request.headers)
        : { host: this.options.upstreamHost, port: this.options.upstreamPort, protocol: this.options.upstreamProtocol, basePath: this.options.upstreamBasePath, agent: this.options.upstreamAgent };
      if (controller.signal.aborted) throw new Error("aborted");
      const payload = JSON.stringify(body);
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
      if (!incoming.headers["content-type"]?.startsWith("text/event-stream")) { incoming.destroy(); throw new Error("invalid upstream content type"); }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const converter = new ChatToResponses(`resp_${randomUUID()}`, body.model, toolNames);
      const emit = async (events: Record<string, unknown>[]): Promise<void> => {
        for (const event of events) {
          if (controller.signal.aborted) throw new Error("aborted");
          if (!response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)) await once(response, "drain", { signal: controller.signal });
        }
      };
      await emit(converter.start());
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let done = false;
      for await (const value of incoming) {
        buffer += decoder.write(Buffer.isBuffer(value) ? value : Buffer.from(value as string));
        if (buffer.length > 2 * 1024 * 1024) throw new ModelConversionError("Chat event exceeds size limit");
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/u.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n");
          if (!data) continue;
          if (done) throw new ModelConversionError("Chat data after DONE");
          if (data === "[DONE]") done = true;
          else {
            const chunk: unknown = JSON.parse(data);
            diagnostics.push(chunk);
            const upstreamError = chatStreamError(chunk);
            if (upstreamError) throw upstreamError;
            await emit(converter.push(chunk));
          }
        }
        if (done) break;
      }
      if (!done) throw new ModelConversionError("Chat stream disconnected before DONE");
      const terminal = converter.finish();
      publishDiagnostics();
      await emit(terminal);
      response.end();
    } catch (error) {
      const message = error instanceof ModelConversionError || error instanceof ChatUpstreamError ? error.message : "Chat upstream request failed";
      if (status === 502 && !controller.signal.aborted) this.options.onError?.(new Error(message));
      const detail = { code: error instanceof ChatUpstreamError ? error.code : status === 400 ? "invalid_request_error" : "chat_upstream_error", message };
      if (error instanceof ChatUpstreamError) diagnostics.error(error.code, response.headersSent ? "stream" : "http", error.retryable);
      publishDiagnostics();
      if (!response.destroyed) {
        if (response.headersSent) {
          response.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: detail } })}\n\n`);
        } else response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: detail }));
      }
    } finally {
      clearTimeout(timer); response.off("close", abort); controller.abort(); this.active.delete(controller);
    }
  }
}
