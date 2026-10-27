import { once } from "node:events";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { OllamaWebSearch, prepareOllamaFreeform, ModelConversionError, type DirectResponsesRequest, type OllamaSearchResult } from "../model-api/index.js";
import { ChatUpstreamError } from "./chat-errors.js";
import { ChatBodyEncodingError, ChatBodyTooLargeError, readChatBody } from "./chat-io.js";
import { DirectResponsesObserver, sendDirectResponses, type DirectResponsesCall } from "./direct-responses.js";
import type { DirectChatCapture } from "./relay-traffic-dump.js";
import { waitForChatOperation } from "./chat-io.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (reason: string): ChatUpstreamError => new ChatUpstreamError("olc_search_invalid_response", `Ollama Cloud 网页搜索返回了无效响应（${reason}）。`, false);
const resultLimit = (reason: string): ChatUpstreamError => new ChatUpstreamError("olc_search_result_limit", `Ollama Cloud 网页搜索结果超过本地处理上限（${reason}）。`, false);

/** Fixed official origin and path. No redirects, result URL fetches or automatic retry. */
export async function executeOllamaWebSearch(authorization: string, query: string, signal: AbortSignal, recheck: () => void,
  agent?: import("node:http").Agent): Promise<OllamaSearchResult[]> {
  const timeout = new ChatUpstreamError("olc_search_timeout", "Ollama Cloud 网页搜索超时。", false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeout), 45_000);
  const operationSignal = AbortSignal.any([signal, controller.signal]);
  let request: ReturnType<typeof httpsRequest> | undefined;
  let incoming: IncomingMessage | undefined;
  try {
    operationSignal.throwIfAborted(); recheck();
    const payload = JSON.stringify({ query, max_results: 5 });
    request = httpsRequest({ hostname: "ollama.com", port: 443, path: "/api/web_search", method: "POST", agent, signal: operationSignal,
      headers: { authorization, "content-type": "application/json", "content-length": Buffer.byteLength(payload), accept: "application/json", "accept-encoding": "identity" } });
    request.on("error", () => undefined);
    const ready = once(request, "response", { signal: operationSignal }); request.end(payload);
    [incoming] = await ready as [IncomingMessage];
    if (incoming.statusCode !== 200) {
      const status = incoming.statusCode ?? 502;
      const reason = status === 401 ? "authentication_error" : status === 403 ? "permission_denied" : status === 429 ? "rate_limit"
        : status === 408 || status === 504 ? "timeout" : "upstream_error";
      throw new ChatUpstreamError(`olc_search_${reason}`, `Ollama Cloud 网页搜索失败（${reason}）。`, false, undefined, status);
    }
    // The fixed search endpoint has returned valid JSON labeled text/html.
    // Keep this observed exception local; model JSON/SSE readers remain strict.
    const encoding = incoming.headers["content-encoding"];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") throw invalid("不支持的正文编码");
    const contentType = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/html") throw invalid("不支持的响应类型");
    const text = await readChatBody(incoming, operationSignal, 256 * 1024);
    let value: unknown; try { value = JSON.parse(text); } catch { throw invalid("正文不是有效 JSON"); }
    if (!record(value) || !Array.isArray(value.results)) throw invalid("缺少 results 数组");
    if (value.results.length > 10) throw resultLimit("结果数量超过 10 条");
    return value.results.map((entry: unknown, index: number) => {
      const position = `第 ${index + 1} 条结果`;
      if (!record(entry)) throw invalid(`${position}不是对象`);
      for (const field of ["title", "url", "content"] as const) {
        if (typeof entry[field] !== "string") throw invalid(`${position}的 ${field} 不是字符串`);
        if (/[\uD800-\uDFFF]/u.test(entry[field])) throw invalid(`${position}的 ${field} 包含无效 Unicode`);
      }
      const { title, url: address, content } = entry as { title: string; url: string; content: string };
      if (Buffer.byteLength(title) > 4096) throw resultLimit(`${position}标题超过 4 KiB`);
      if (Buffer.byteLength(address) > 8192) throw resultLimit(`${position}地址超过 8 KiB`);
      // content is bounded by the complete response and cumulative result budgets.
      // Valid long snippets must not invalidate an otherwise bounded search.
      if (!/^https?:\/\//iu.test(address)) throw invalid(`${position}地址不是 HTTP(S)`);
      if (/[\s\p{Cc}]/u.test(address)) throw invalid(`${position}地址包含空白或控制字符`);
      let url: URL; try { url = new URL(address); } catch { throw invalid(`${position}地址无法解析`); }
      if (!url.hostname || url.username || url.password) throw invalid(`${position}地址缺少主机或包含凭据`);
      return { title, url: address, content };
    });
  } catch (error) {
    if (operationSignal.aborted) throw signal.aborted ? signal.reason : timeout;
    if (error instanceof ChatUpstreamError && error.code.startsWith("olc_search_")) throw error;
    if (error instanceof ChatBodyTooLargeError) throw resultLimit("单次响应超过 256 KiB");
    if (error instanceof ChatBodyEncodingError) throw invalid("正文不是有效 UTF-8");
    if (incoming?.statusCode === 200) throw new ChatUpstreamError("olc_search_upstream_error", "Ollama Cloud 网页搜索正文读取中断。", false);
    throw new ChatUpstreamError("olc_search_upstream_error", "Ollama Cloud 网页搜索连接失败。", false);
  } finally { clearTimeout(timer); incoming?.destroy(); request?.destroy(); }
}

/** Both entry points retain authorization ownership; all raw model rounds use the shared reader/capture. */
export async function sendOllamaSearchResponses(call: DirectResponsesCall & {
  search: OllamaWebSearch;
  refresh(signal: AbortSignal): Promise<void>;
  nextCapture?(signal: AbortSignal): Promise<DirectChatCapture | undefined>;
  captureChanged?(capture: DirectChatCapture | undefined): void;
  deadlineAt?: number;
  cancel?(reason: Error): void;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = new ChatUpstreamError("olc_search_deadline", "Ollama Cloud 网页搜索请求总期限已到。", false);
  const expire = (): void => { controller.abort(timeout); call.cancel?.(timeout); };
  const remaining = (call.deadlineAt ?? performance.now() + 10 * 60_000) - performance.now();
  const timer = setTimeout(expire, Math.max(0, remaining));
  if (remaining <= 0) expire();
  const signal = AbortSignal.any([call.signal, controller.signal]);
  const emit = async (value: Record<string, unknown>, terminal: boolean): Promise<void> =>
    waitForChatOperation(call.emit(call.request.stream ? call.search.forDelivery(value) : value, terminal), signal);
  let body = call.request;
  let searchCount = 0;
  let resultBytes = 0;
  let sentStart = false;
  let submitted = false;
  let capture = call.capture;
  try {
    for (let round = 0; round < 8; round++) {
      signal.throwIfAborted(); await waitForChatOperation(call.refresh(signal), signal); signal.throwIfAborted(); call.recheck();
      if (round > 0 && call.nextCapture) {
        const pending = call.nextCapture(signal);
        void pending.then(value => { if (signal.aborted) value?.finish("failed", "failed", "preparation_cancelled"); }, () => {});
        capture = await waitForChatOperation(pending, signal); signal.throwIfAborted(); call.captureChanged?.(capture);
      }
      const adapted = prepareOllamaFreeform(body);
      const observer = new DirectResponsesObserver();
      const done = new Map<string, Record<string, unknown>>();
      let terminal: Record<string, unknown> | undefined;
      let rawTerminal: Record<string, unknown> | undefined;
      const roundCall = { ...call }; delete roundCall.capture;
      try {
        // Freeform history wraps raw text in a JSON string and can expand it.
        // Both per-request and cumulative input limits apply to actual wire input.
        if (Buffer.byteLength(JSON.stringify(adapted.body)) > 4 * 1024 * 1024) throw new ModelConversionError("Ollama Cloud 网页搜索上下文超限。");
        call.search.prepareRound(adapted.body);
        await sendDirectResponses({ ...roundCall, ...(capture ? { capture } : {}), signal, request: adapted.body as DirectResponsesRequest, adapter: adapted.adapter, observer,
        headers: status => { if (status >= 400) call.observer.receivedError(performance.now()); call.headers(status); },
        observeValue: (value, stream, at) => {
          const response = stream ? value.response : value;
          if ((!stream || ["response.completed", "response.failed", "response.incomplete"].includes(String(value.type))) && record(response)) rawTerminal = response;
          call.observer.progress(value, stream, at); call.observeValue?.(value, stream, at);
          if (call.observer.hasContent) call.content();
        },
        submitted: (...args) => { call.search.beginRound(); if (!submitted) { submitted = true; call.observer.submitted(performance.now()); } call.submitted(...args); },
        content: () => {}, emit: (value, ended) => {
          if (value.type === "response.output_item.done" && record(value.item) && typeof value.item.id === "string") {
            if (done.has(value.item.id)) throw new ModelConversionError("Ollama Cloud 模型重复完成输出项。");
            done.set(value.item.id, value.item);
          }
          if (ended) terminal = body.stream ? value.response as Record<string, unknown> : value;
          return Promise.resolve();
        } }); } finally {
        adapted.adapter.close();
        if (observer.status !== "unknown" && rawTerminal) call.search.recordUsage(rawTerminal);
      }
      signal.throwIfAborted();
      if (!terminal) throw new ModelConversionError("Ollama Cloud 模型轮缺少终态。");
      if (body.stream && Array.isArray(terminal.output)) for (const item of terminal.output) {
        if (!record(item) || item.type !== "function_call" && item.type !== "custom_tool_call" && item.type !== "tool_search_call") continue;
        const previous = done.get(String(item.id));
        const signature = (value: Record<string, unknown>): string => JSON.stringify([value.type, value.call_id, value.name, value.namespace, value.execution, value.arguments, value.input]);
        if (!previous || signature(previous) !== signature(item)) throw new ModelConversionError("Ollama Cloud 工具终态与完成项不一致。");
      }
      const accepted = call.search.accept(terminal);
      call.observer.aggregateUsage(call.search.usageValue());
      if (!accepted.calls.length) {
        if (body.stream && !sentStart) { await emit(call.search.start(), false); sentStart = true; }
        const finished = call.search.finish(terminal, accepted.history);
        call.observer.observe(finished.response, false);
        call.observer.aggregateUsage(call.search.usageValue());
        if (call.observer.hasContent) call.content();
        if (body.stream) {
          for (const event of finished.events) await emit(event, String(event.type) === `response.${String(finished.response.status)}`);
        } else await emit(finished.response, true);
        return;
      }
      if (call.nextCapture) { capture?.finish("completed", "finished", undefined, observer.firstTokenMs, observer.responseModel, observer.timing); capture = undefined; call.captureChanged?.(undefined); }
      if (searchCount + accepted.calls.length > 4) throw new ModelConversionError("Ollama Cloud 网页搜索次数超限。");
      call.search.beforeSearch(accepted.history);
      if (body.stream && !sentStart) { await emit(call.search.start(), false); sentStart = true; }
      const startedEvents = call.search.beginSearches(accepted.calls);
      if (body.stream) for (const event of startedEvents) await emit(event, false);
      const results: OllamaSearchResult[][] = [];
      for (const search of accepted.calls) {
        signal.throwIfAborted(); await waitForChatOperation(call.refresh(signal), signal); signal.throwIfAborted(); call.recheck();
        const result = await executeOllamaWebSearch(call.target.authorization, search.query, signal, () => call.recheck(), call.target.agent);
        resultBytes += Buffer.byteLength(JSON.stringify(result));
        if (resultBytes > 512 * 1024) throw resultLimit("累计结果超过 512 KiB");
        results.push(result); searchCount++;
        const completedEvents = call.search.completeSearch(search.callId);
        if (body.stream) for (const event of completedEvents) await emit(event, false);
      }
      body = call.search.continuation(accepted.history, accepted.calls, results) as DirectResponsesRequest;
    }
    throw new ModelConversionError("Ollama Cloud 网页搜索模型轮数超限。");
  } finally { call.observer.aggregateUsage(call.search.usageValue()); clearTimeout(timer); }
}
