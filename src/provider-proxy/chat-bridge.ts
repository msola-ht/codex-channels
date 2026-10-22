import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { ChatToResponses, ModelConversionError, clinePassChatReasoningControl, responsesToChat } from "../model-api/index.js";
import { ChatDiagnostics, ChatDiagnosticsChannel, chatDiagnosticsHeader } from "./chat-diagnostics.js";
import { ChatUpstreamError, ModelRequestTimeoutError, type ModelRequestStage, chatStreamError } from "./chat-errors.js";
import { parseDirectModelJson, validateDirectModelResponse } from "./direct-model-http.js";
import type { ProviderProxyOptions } from "./proxy.js";
import {
  ChatBodyTooLargeError,
  drainRejectedRequest,
  readChatBody,
  readModelFrames,
  waitForChatOperation,
  writeChatData,
} from "./chat-io.js";
import { pinClinePassRouting } from "./cline-pass-routing.js";
import { executeClineWebSearch } from "./cline-web-search.js";
import { ChatGenerationTimingObserver } from "./generation-timing.js";
import { chatBridgeAuthorizationHeader, forwardedRequestHeaders } from "./request-routing.js";
import type { UpstreamTiming } from "./response-metrics-observer.js";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";
import type { ClinePassRequestProfile } from "../../runtime/chat-reasoning.mjs";
import {
  maximumModelRequestBytes,
  maximumRetainedModelRequestBytes,
} from "./model-request-limits.js";

interface ClinePassModelCapabilities {
  reasoningEfforts: readonly string[];
  clineRequestProfile?: ClinePassRequestProfile;
}

const maximumRequestBytes = maximumModelRequestBytes;
const maximumRetainedRequestBytes = maximumRetainedModelRequestBytes;
// All account bridges in this process share admission. Reserve the full body
// allowance before attaching a reader, including uploads without Content-Length.
let retainedRequestBytes = 0;

/** HTTP lifecycle adapter. Pure model conversion lives in model-api. */
export class ChatCompletionsBridge {
  readonly diagnostics = new ChatDiagnosticsChannel();
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private readonly localToken = randomBytes(32).toString("hex");
  private readonly server = createServer((request, response) => {
    const pending = this.handle(request, response);
    this.pending.add(pending);
    void pending.catch(() => response.destroy()).finally(() => this.pending.delete(pending));
  });
  constructor(private readonly options: ProviderProxyOptions & {
    clinePass?: boolean;
    readClinePassModelCapabilities?: (model: string, signal: AbortSignal) => Promise<ClinePassModelCapabilities | undefined>;
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
      localChatBridgeToken: this.localToken,
    };
  }
  async close(): Promise<void> {
    for (const controller of this.active) controller.abort();
    this.server.closeAllConnections();
    this.diagnostics.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.allSettled(this.pending);
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reject = (status: number, code: string, message: string): void => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.once("finish", () => request.destroy());
      response.end(JSON.stringify({ error: { code, message } }));
    };
    if (request.method !== "POST" || request.url !== "/responses") {
      reject(404, "unsupported_path", "Unsupported Chat bridge path"); return;
    }
    const token = request.headers[chatBridgeAuthorizationHeader];
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(this.localToken))) {
      reject(401, "chat_bridge_unauthorized", "Chat bridge local identity is required"); return;
    }
    const declared = Number(request.headers["content-length"]);
    const reservedBytes = Number.isSafeInteger(declared) && declared >= 0
      ? Math.min(declared, maximumRequestBytes)
      : maximumRequestBytes;
    if (retainedRequestBytes + reservedBytes > maximumRetainedRequestBytes) {
      reject(503, "chat_bridge_capacity_exceeded", "Chat bridge request capacity is exhausted"); return;
    }
    retainedRequestBytes += reservedBytes;
    // processRequest owns all body-derived references and cancellation cleanup.
    // Its frame must finish before this reservation becomes available again.
    try { await this.processRequest(request, response); }
    finally { retainedRequestBytes -= reservedBytes; }
  }
  private async processRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const terminalController = new AbortController();
    this.active.add(controller);
    this.active.add(terminalController);
    let status = 400;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const phaseTimeout = (timeoutMs: number, stage: ModelRequestStage): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort(new ModelRequestTimeoutError(stage));
      }, timeoutMs);
    };
    phaseTimeout(modelRequestPolicy.preparationTimeoutMs, "upload");
    const abort = (): void => { controller.abort(); terminalController.abort(); };
    response.once("close", abort);
    request.once("aborted", abort);
    let upstreamRequest: ReturnType<typeof httpRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    const finishResponse = async (data?: string): Promise<void> => {
      const terminalTimer = setTimeout(() => terminalController.abort(new ModelRequestTimeoutError("terminal")), modelRequestPolicy.terminalDeliveryTimeoutMs);
      try {
        const finished = once(response, "finish", { signal: terminalController.signal });
        // Attach a rejection handler before a synchronous write can fail.
        void finished.catch(() => undefined);
        if (data !== undefined) await writeChatData(response, data, terminalController.signal, undefined, modelRequestPolicy.terminalDeliveryTimeoutMs, "terminal");
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
    let converter: ChatToResponses | undefined;
    const publishDiagnostics = (): void => this.diagnostics.publish(request.headers[chatDiagnosticsHeader], { ...diagnostics.snapshot(), ...(timing ? { timing } : {}) });
    const observeFirstResponse = (at: number): void => {
      if (!timing || timing.responseTimeMs !== undefined) return;
      timing.responseTimeMs = at - timing.submittedAt;
      // Publish before downstream output: a disconnect closes the proxy subscription.
      publishDiagnostics();
    };
    try {
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new ModelConversionError("Compressed model requests are unsupported");
      const payloadBody = await readChatBody(request, controller.signal, maximumRequestBytes);
      phaseTimeout(modelRequestPolicy.preparationTimeoutMs, "prepare");
      const source: unknown = JSON.parse(payloadBody);
      const requestedModel = source && typeof source === "object" && "model" in source ? source.model : undefined;
      let modelCapabilities: ClinePassModelCapabilities | undefined;
      status = 502;
      const upstreamHeaders = { ...request.headers };
      delete upstreamHeaders[chatBridgeAuthorizationHeader];
      const upstream = this.options.resolveUpstream
        ? await waitForChatOperation(Promise.resolve(this.options.resolveUpstream(upstreamHeaders, controller.signal)), controller.signal)
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
      const { request: body, toolNames, structuredOutput, webSearch } = responsesToChat(source, modelCapabilities?.reasoningEfforts,
        this.options.clinePass ? { clinePass: true, clineWebSearch: true } : { structuredOutputWithTools: "prompt" });
      // 结构化输出降级只由提示词保证，记录有界事实以便与“模型没按 JSON 输出”区分。
      if (structuredOutput !== undefined) diagnostics.conversion({ structuredOutput });
      const { reasoning, ...parameters } = body;
      const outbound = this.options.clinePass && reasoning
        ? { ...parameters, ...clinePassChatReasoningControl(body.model, reasoning.effort, modelCapabilities?.clineRequestProfile) }
        : body;
      const headers = forwardedRequestHeaders(request.headers, upstream.host, upstream.port, this.options.upstreamUserAgent);
      delete headers[chatDiagnosticsHeader];
      delete headers["content-encoding"];
      Object.assign(headers, { "content-type": "application/json", accept: "text/event-stream", "accept-encoding": "identity" });
      converter = new ChatToResponses(`resp_${randomUUID()}`, body.model, toolNames);
      const emit = async (events: Record<string, unknown>[]): Promise<void> => {
        for (const event of events) {
          controller.signal.throwIfAborted();
          try {
            await writeChatData(response, `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`, controller.signal, () => { generationBlocked = true; });
          } catch (error) {
            if (error instanceof ModelRequestTimeoutError) controller.abort(error);
            throw error;
          }
        }
      };
      let searchCount = 0;
      let deferredClientCalls = 0;
      let remainingTokens = body.max_completion_tokens;
      for (;;) {
        // Continuations are new billable calls: recheck the catalog before each submission.
        if (searchCount > 0 && this.options.clinePass) {
          phaseTimeout(modelRequestPolicy.preparationTimeoutMs, "prepare");
          let current: ClinePassModelCapabilities | undefined;
          try {
            current = await waitForChatOperation(this.options.readClinePassModelCapabilities!(body.model, controller.signal), controller.signal);
          } catch {
            controller.signal.throwIfAborted();
            throw new ChatUpstreamError("clp_catalog_unavailable", "CLP 模型目录暂时无法安全读取，请检查目录后重新选择已启用的模型。", false, undefined, 503);
          }
          if (!current) throw new ChatUpstreamError("clp_model_disabled", "该 CLP 模型已停用或不在当前目录中，请重新选择已启用的模型。", false, undefined, 409);
          if (JSON.stringify(current) !== JSON.stringify(modelCapabilities)) throw new ChatUpstreamError("clp_catalog_unavailable", "CLP 模型配置在搜索期间发生变化，请重新发起请求。", false, undefined, 503);
        }
        const payload = JSON.stringify(this.options.clinePass ? pinClinePassRouting(outbound, modelCapabilities?.clineRequestProfile) : outbound);
        const payloadBytes = Buffer.byteLength(payload);
        if (payloadBytes > maximumRequestBytes) throw new ModelConversionError("Chat continuation exceeds size limit");
        headers["content-length"] = String(payloadBytes);
        status = 502;
        clearTimeout(timer);
        upstreamRequest = (upstream.protocol === "http" ? httpRequest : httpsRequest)({
          hostname: upstream.host, port: upstream.port, agent: upstream.agent,
          path: `${upstream.basePath?.replace(/\/$/u, "") ?? ""}/chat/completions`,
          method: "POST", headers, signal: controller.signal,
        });
        upstreamRequest.on("error", () => undefined);
        const ready = once(upstreamRequest, "response", { signal: controller.signal });
        timing ??= { submittedAt: performance.now() };
        timing.requestBytes = (timing.requestBytes ?? 0) + payloadBytes;
        phaseTimeout(modelRequestPolicy.headersTimeoutMs, "headers");
        converter.beginModelRound();
        upstreamRequest.end(payload);
        // Publish the submitted size before waiting for headers: a client disconnect
        // closes the outer proxy's subscription even if the upstream never responds.
        publishDiagnostics();
        [incoming] = await ready as [IncomingMessage];
        clearTimeout(timer);
        diagnostics.header(incoming.headers["x-request-id"]);
        diagnostics.responseStatus(incoming.statusCode);
        publishDiagnostics();
        if (incoming.statusCode !== 200) {
          status = incoming.statusCode && incoming.statusCode >= 400 ? incoming.statusCode : 502;
        }
        await validateDirectModelResponse(incoming, true, { value: value => {
            diagnostics.push(value);
            if (chatStreamError(value)) observeFirstResponse(performance.now());
          }, invalid: () => {} }, controller.signal, outbound.tools);
        if (!response.headersSent) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          await emit(converter.start());
        }
        let done = false;
        for await (const { data, receivedAt } of readModelFrames(incoming, controller.signal, {
          frameBytes: Infinity, bufferBytes: Infinity, totalBytes: Infinity, bufferCharacters: 2 * 1024 * 1024,
        })) {
          if (data === "[DONE]") { done = true; break; }
          const chunk: unknown = parseDirectModelJson(data);
          diagnostics.push(chunk);
          const upstreamError = chatStreamError(chunk, outbound.tools);
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
        incoming.destroy();
        upstreamRequest.destroy();
        const searches = webSearch ? converter.hostedSearchCalls(webSearch.name) : [];
        if (!webSearch || searches.length === 0) break;
        const choice = outbound.tool_choice;
        if (choice !== undefined && choice !== "auto" && choice !== "required"
          && !(typeof choice === "object" && choice !== null && "type" in choice && choice.type === "function"
            && "function" in choice && typeof choice.function === "object" && choice.function !== null
            && "name" in choice.function && choice.function.name === webSearch.name)) {
          throw new ChatUpstreamError("clp_search_tool_choice", "上游返回的搜索调用违反本轮工具选择限制，已阻止联网搜索。", false);
        }
        generationBlocked = true; // Multiple model generations plus network search are not one decoding interval.
        if (searchCount + searches.length > 4) throw new ChatUpstreamError("clp_search_limit", "本次模型请求已达到最多 4 次网页搜索的限制。", false);
        if (remainingTokens !== undefined) {
          const spent = converter.lastRoundOutputTokens();
          if (spent === undefined || spent >= remainingTokens) throw new ChatUpstreamError("clp_search_output_limit", "搜索后的模型续答无法在剩余输出额度内继续。", false);
          remainingTokens -= spent;
          outbound.max_completion_tokens = remainingTokens;
        }
        const results = [];
        for (const call of searches) {
          controller.signal.throwIfAborted();
          await emit(converter.beginHostedSearch(call));
          const sources = await executeClineWebSearch({ host: upstream.host, ...(upstream.port === undefined ? {} : { port: upstream.port }),
            protocol: upstream.protocol ?? "https", ...(upstream.basePath === undefined ? {} : { basePath: upstream.basePath }),
            ...(upstream.agent === undefined ? {} : { agent: upstream.agent }) }, headers,
          { query: call.query, ...(webSearch.allowedDomains ? { allowedDomains: webSearch.allowedDomains } : {}) }, controller.signal);
          results.push({ ...call, sources, text: JSON.stringify({ results: sources }) });
          searchCount++;
        }
        const step = converter.completeHostedSearches(webSearch.name, results);
        await emit(step.events);
        if (step.deferredClientCalls > 0) {
          deferredClientCalls += step.deferredClientCalls;
          diagnostics.conversion({ webSearchCoordination: "serialized", webSearchDeferredClientCalls: deferredClientCalls });
          publishDiagnostics();
        }
        outbound.messages.push(step.message, ...step.toolMessages);
        // A forced initial search must not force an unbounded loop on the next model call.
        if (outbound.tool_choice === "required" || typeof outbound.tool_choice === "object" && outbound.tool_choice !== null
          && "function" in outbound.tool_choice && (outbound.tool_choice.function as { name?: unknown })?.name === webSearch.name) outbound.tool_choice = "auto";
      }
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
      let failure = error instanceof ModelConversionError || error instanceof ChatUpstreamError ? error
        : aborted;
      if (failure instanceof ModelConversionError && failure.diagnostics?.webSearch === "unsupported_controls") {
        const control = failure.diagnostics.webSearchControl;
        const reason = control === "external_web_access" ? "external_web_access 必须为 true，请将联网搜索设为 live。"
          : control === "indexed_web_access" ? "不支持 indexed_web_access 索引控制，请改用 live 并移除索引控制。"
            : control === "user_location" ? "不支持 user_location 地域控制，请移除该控制；仅改为 live 不会移除它。"
              : control === "search_context_size" ? "不支持 search_context_size 上下文档位，请移除该控制。"
                : control === "search_content_types" ? "不支持 search_content_types 内容类型控制，请移除该控制。"
                  : "请求含未支持的搜索控制字段；请移除额外控制，仅保留 live 文本搜索及域名过滤。";
        diagnostics.conversion(failure.diagnostics);
        failure = new ChatUpstreamError("clp_search_unsupported_controls", `CLP 搜索参数不受支持：${reason}`, false);
      }
      if (failure instanceof ModelRequestTimeoutError) status = failure.status;
      else if (failure instanceof ChatUpstreamError && failure.upstreamStatus) status = failure.upstreamStatus;
      if (failure instanceof ChatBodyTooLargeError) await drainRejectedRequest(request);
      const message = failure?.message ?? "Chat upstream request failed";
      if (status === 502 && (!controller.signal.aborted || aborted)) this.options.onError?.(new Error(message));
      controller.abort(failure);
      const detail = { code: failure instanceof ChatUpstreamError ? failure.code : status === 400 ? "invalid_request_error" : "chat_upstream_error", message,
        ...(failure instanceof ModelRequestTimeoutError ? { timeout_stage: failure.stage } : {}) };
      diagnostics.error(detail.code, response.headersSent ? "stream" : "http", failure instanceof ChatUpstreamError && failure.retryable,
        failure instanceof ModelRequestTimeoutError ? failure.stage : undefined);
      if (failure instanceof ModelConversionError && failure.diagnostics) diagnostics.conversion(failure.diagnostics);
      publishDiagnostics();
      if (!response.destroyed) {
        try {
          if (response.headersSent) {
            // Codex treats unknown SSE error codes as retryable. Preserve the
            // local classification in type while stopping permanent CLP failures.
            const wireDetail = failure instanceof ChatUpstreamError && failure.code.startsWith("clp_")
              ? { ...detail, type: detail.code, code: failure.retryable ? detail.code : "invalid_prompt",
                ...(failure.retryable && failure.retryAfter !== undefined ? { headers: { "retry-after": failure.retryAfter } } : {}) }
              : detail;
            const events = converter?.fail(wireDetail) ?? [{ type: "response.failed", response: { status: "failed", error: wireDetail } }];
            await finishResponse(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
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
