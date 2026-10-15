import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { ChatToResponses, ModelConversionError, clinePassChatReasoningControl, responsesToChat } from "../model-api/index.js";
import { ChatDiagnostics, ChatDiagnosticsChannel, chatDiagnosticsHeader } from "./chat-diagnostics.js";
import { ChatUpstreamError, chatStreamError, chatUpstreamError, readChatHttpError } from "./chat-errors.js";
import type { ProviderProxyOptions } from "./proxy.js";
import { readChatBody, readModelFrames, waitForChatOperation, writeChatData } from "./chat-io.js";
import { pinClinePassRouting } from "./cline-pass-routing.js";
import { ChatGenerationTimingObserver } from "./generation-timing.js";
import type { UpstreamTiming } from "./response-metrics-observer.js";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";

/** HTTP lifecycle adapter. Pure model conversion lives in model-api. */
export class ChatCompletionsBridge {
  readonly diagnostics = new ChatDiagnosticsChannel();
  private readonly active = new Set<AbortController>();
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  constructor(private readonly options: ProviderProxyOptions & {
    clinePass?: boolean;
    readClinePassModelCapabilities?: (model: string, signal: AbortSignal) => Promise<{ reasoningEfforts: readonly string[] } | undefined>;
  }) {}
  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
  }
  address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Chat bridge is not listening");
    return `127.0.0.1:${address.port}`;
  }
  /** 模型出口时钟归桥所有，外层统计代理只负责取消和交付。 */
  proxyOptions(): ProviderProxyOptions {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Chat bridge is not listening");
    return {
      upstreamHost: "127.0.0.1",
      upstreamPort: address.port,
      upstreamProtocol: "http",
      chatDiagnostics: this.diagnostics,
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
    const terminalController = new AbortController();
    this.active.add(controller);
    this.active.add(terminalController);
    let status = 400;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const phaseTimeout = (timeoutMs: number, upload = false): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (upload) status = 408;
        controller.abort(upload
          ? new ChatUpstreamError("request_timeout", "请求正文接收超时，请重试。", true)
          : chatUpstreamError({ code: "upstream_timeout" }));
      }, timeoutMs);
    };
    phaseTimeout(modelRequestPolicy.preparationTimeoutMs, true);
    const abort = (): void => { controller.abort(); terminalController.abort(); };
    response.once("close", abort);
    request.once("aborted", abort);
    let upstreamRequest: ReturnType<typeof httpRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    const finishResponse = async (data?: string): Promise<void> => {
      const terminalTimer = setTimeout(() => terminalController.abort(new ChatUpstreamError("delivery_timeout", "模型响应交付超时，请重试。", true)), modelRequestPolicy.terminalDeliveryTimeoutMs);
      try {
        const finished = once(response, "finish", { signal: terminalController.signal });
        // Attach a rejection handler before a synchronous write can fail.
        void finished.catch(() => undefined);
        if (data !== undefined) await writeChatData(response, data, terminalController.signal, undefined, modelRequestPolicy.terminalDeliveryTimeoutMs);
        response.end();
        await finished;
      } catch (error) {
        terminalController.abort(error);
        response.destroy();
        throw error;
      } finally { clearTimeout(terminalTimer); }
    };
    const diagnostics = new ChatDiagnostics();
    const generation = new ChatGenerationTimingObserver();
    let generationBlocked = false;
    let timing: UpstreamTiming | undefined;
    let usage: Record<string, unknown> | undefined;
    const publishDiagnostics = (): void => this.diagnostics.publish(request.headers[chatDiagnosticsHeader], { ...diagnostics.snapshot(), ...(timing ? { timing } : {}) });
    const observeFirstResponse = (at: number): void => {
      if (!timing || timing.responseTimeMs !== undefined) return;
      timing.responseTimeMs = at - timing.submittedAt;
      // Publish before downstream output: a disconnect closes the proxy subscription.
      publishDiagnostics();
    };
    try {
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new ModelConversionError("Compressed model requests are unsupported");
      const payloadBody = await readChatBody(request, controller.signal, 16 * 1024 * 1024);
      phaseTimeout(modelRequestPolicy.preparationTimeoutMs);
      const source: unknown = JSON.parse(payloadBody);
      const requestedModel = source && typeof source === "object" && "model" in source ? source.model : undefined;
      let modelCapabilities: { reasoningEfforts: readonly string[] } | undefined;
      status = 502;
      const upstream = this.options.resolveUpstream
        ? await waitForChatOperation(Promise.resolve(this.options.resolveUpstream(request.headers, controller.signal)), controller.signal)
        : { host: this.options.upstreamHost, port: this.options.upstreamPort, protocol: this.options.upstreamProtocol, basePath: this.options.upstreamBasePath, agent: this.options.upstreamAgent };
      if (controller.signal.aborted) throw new Error("aborted");
      // Check the requested model before capability-dependent conversion: a resumed
      // disabled model may carry Codex fallback controls that this bridge rejects.
      if (this.options.clinePass && typeof requestedModel === "string" && requestedModel.length > 0) {
        try {
          if (!this.options.readClinePassModelCapabilities) throw new Error("CLP catalog guard is unavailable");
          modelCapabilities = await waitForChatOperation(this.options.readClinePassModelCapabilities(requestedModel, controller.signal), controller.signal);
        } catch {
          controller.signal.throwIfAborted();
          status = 503;
          throw new ChatUpstreamError("clp_catalog_unavailable", "CLP 模型目录暂时无法安全读取，请检查目录后重新选择已启用的模型。", false);
        }
        if (!modelCapabilities) {
          status = 409;
          throw new ChatUpstreamError("clp_model_disabled", "该 CLP 模型已停用或不在当前目录中，请重新选择已启用的模型。", false);
        }
      }
      if (controller.signal.aborted) throw new Error("aborted");
      status = 400;
      // 自定义 Chat 上游可能不接受 response_format 与 tools 并存（托管 CLP 上游已验证接受，保持原样）。
      const { request: body, toolNames, structuredOutput } = responsesToChat(source, modelCapabilities?.reasoningEfforts,
        this.options.clinePass ? {} : { structuredOutputWithTools: "prompt" });
      // 结构化输出降级只由提示词保证，记录有界事实以便与“模型没按 JSON 输出”区分。
      if (structuredOutput !== undefined) diagnostics.conversion({ structuredOutput });
      const { reasoning, ...parameters } = body;
      const outbound = this.options.clinePass && reasoning
        ? { ...parameters, ...clinePassChatReasoningControl(body.model, reasoning.effort) }
        : body;
      const payload = JSON.stringify(this.options.clinePass ? pinClinePassRouting(outbound) : outbound);
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", "content-length": String(Buffer.byteLength(payload)) };
      if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
      if (this.options.upstreamUserAgent) headers["user-agent"] = this.options.upstreamUserAgent;
      status = 502;
      clearTimeout(timer);
      upstreamRequest = (upstream.protocol === "http" ? httpRequest : httpsRequest)({
        hostname: upstream.host, port: upstream.port, agent: upstream.agent,
        path: `${upstream.basePath?.replace(/\/$/u, "") ?? ""}/chat/completions`,
        method: "POST", headers, signal: controller.signal,
      });
      const ready = once(upstreamRequest, "response", { signal: controller.signal });
      timing = { submittedAt: performance.now() };
      phaseTimeout(modelRequestPolicy.headersTimeoutMs);
      upstreamRequest.end(payload);
      [incoming] = await ready as [IncomingMessage];
      clearTimeout(timer);
      diagnostics.header(incoming.headers["x-request-id"]);
      diagnostics.responseStatus(incoming.statusCode);
      publishDiagnostics();
      if (incoming.statusCode !== 200) {
        status = incoming.statusCode && incoming.statusCode >= 400 ? incoming.statusCode : 502;
        throw await readChatHttpError(incoming, { value: value => {
          diagnostics.push(value);
          if (chatStreamError(value)) observeFirstResponse(performance.now());
        }, invalid: () => {} }, controller.signal);
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
          try {
            await writeChatData(response, `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`, controller.signal, () => { generationBlocked = true; });
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT") {
              controller.abort(new ChatUpstreamError("delivery_timeout", "模型响应交付超时，请重试。", true));
            }
            throw error;
          }
        }
      };
      await emit(converter.start());
      let done = false;
      for await (const { data, receivedAt } of readModelFrames(incoming, controller.signal, {
        frameBytes: Infinity, bufferBytes: Infinity, totalBytes: Infinity, bufferCharacters: 2 * 1024 * 1024,
      })) {
        if (data === "[DONE]") { done = true; break; }
        const chunk: unknown = JSON.parse(data);
        diagnostics.push(chunk);
        const upstreamError = chatStreamError(chunk);
        if (upstreamError) { observeFirstResponse(receivedAt); throw upstreamError; }
        const events = converter.push(chunk);
        observeFirstResponse(receivedAt);
        generation.push(chunk, receivedAt);
        if (timing.firstTokenMs === undefined && generation.firstContentAt !== undefined) {
          timing.firstTokenMs = generation.firstContentAt - timing.submittedAt;
          publishDiagnostics();
        }
        if (chunk && typeof chunk === "object" && "usage" in chunk && chunk.usage && typeof chunk.usage === "object") usage = chunk.usage as Record<string, unknown>;
        await emit(events);
      }
      if (!done) throw new ModelConversionError("Chat stream disconnected before DONE");
      const terminal = converter.finish();
      timing.totalDurationMs = performance.now() - timing.submittedAt;
      const details = usage?.completion_tokens_details as { reasoning_tokens?: number } | undefined;
      if (!generationBlocked && terminal.some(event => event.type === "response.completed")) {
        const measured = generation.finish(usage?.completion_tokens as number | undefined, details?.reasoning_tokens);
        if (measured) timing.generationTiming = measured;
      }
      publishDiagnostics();
      await finishResponse(terminal.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      clearTimeout(timer);
      // 桥自身超时通过中止原因传递，与上游返回的错误使用同一套分类。
      const aborted = controller.signal.reason instanceof ChatUpstreamError ? controller.signal.reason
        : terminalController.signal.reason instanceof ChatUpstreamError ? terminalController.signal.reason : undefined;
      const failure = error instanceof ModelConversionError || error instanceof ChatUpstreamError ? error
        : aborted ?? (error instanceof Error && "code" in error && error.code === "ETIMEDOUT" ? chatUpstreamError({ code: "upstream_timeout" }) : undefined);
      const message = failure?.message ?? "Chat upstream request failed";
      if (status === 502 && (!controller.signal.aborted || aborted)) this.options.onError?.(new Error(message));
      controller.abort(failure);
      const detail = { code: failure instanceof ChatUpstreamError ? failure.code : status === 400 ? "invalid_request_error" : "chat_upstream_error", message };
      diagnostics.error(detail.code, response.headersSent ? "stream" : "http", failure instanceof ChatUpstreamError && failure.retryable);
      if (failure instanceof ModelConversionError && failure.diagnostics) diagnostics.conversion(failure.diagnostics);
      publishDiagnostics();
      if (!response.destroyed) {
        try {
          if (response.headersSent) {
            await finishResponse(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: detail } })}\n\n`);
          } else {
            // 未读完的正文不能复用连接；先送达错误，再释放入站请求。
            if (!request.complete) {
              response.setHeader("connection", "close");
              response.once("finish", () => request.destroy());
            }
            if (failure instanceof ChatUpstreamError && failure.retryAfter !== undefined) {
              response.setHeader("retry-after", failure.retryAfter);
            }
            response.writeHead(status, { "content-type": "application/json" });
            await finishResponse(JSON.stringify({ error: detail }));
          }
        } catch { response.destroy(); }
      }
    } finally {
      clearTimeout(timer); response.off("close", abort); request.off("aborted", abort);
      controller.abort(); terminalController.abort(); upstreamRequest?.destroy();
      if (incoming && !incoming.complete) incoming.destroy();
      this.active.delete(controller); this.active.delete(terminalController);
    }
  }
}
