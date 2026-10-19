import { randomBytes } from "node:crypto";
import { fetch as undiciFetch, ProxyAgent } from "undici";

import { DirectChatResponse, clinePassChatReasoningControl, responsesToChat } from "../dist/model-api/index.js";
import { pinClinePassRouting } from "../dist/provider-proxy/index.js";
import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { createRefreshableHttpProxySelector } from "../runtime/network-proxy.mjs";
import { isValidCustomProviderApiKey, validProviderBaseUrl } from "../runtime/model-provider-runtime.mjs";

const capabilityNames = ["applyPatch", "toolSearch", "webSearch"];
const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const maximumResponseBytes = 128 * 1024;
const maximumRequests = 3;
// Codex rust-v0.160.1 core/assets/tools/apply_patch.lark；生产包不读取 upstream/。
const patchGrammar = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
const searchTool = {
  type: "tool_search", execution: "client", description: "Find additional client tools by name.",
  parameters: {type: "object", properties: {query: {type: "string"}, limit: {type: "integer"}}, required: ["query"]},
};
const message = text => ({type: "message", role: "user", content: [{type: "input_text", text}]});
const marker = () => `PROBE_${randomBytes(8).toString("hex")}`;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validModelId = value => typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/\p{Cc}/u.test(value);

/** 按用户选择检测单项工具能力；原生搜索可能由上游执行，不保存历史或自动重试。 */
export async function probeCustomModelCapabilities({baseUrl, apiKey, model, upstreamWireApi, capability, reasoningEffort, environment = process.env, signal, timeoutMs = 45000}) {
  return probeModelCapabilities({baseUrl, apiKey, model, upstreamWireApi, capability, reasoningEffort, environment, signal, timeoutMs});
}

/** 已配置 Provider 诊断复用相同的请求预算和证据判定；连接上下文只由服务器配置解析。 */
export async function probeNativeWebSearch(input) {
  return probeModelCapabilities({...input, capability: "webSearch"});
}

async function probeModelCapabilities({baseUrl, apiKey, model, upstreamWireApi, capability, reasoningEffort,
  environment = process.env, signal, timeoutMs = 45000, requestContext}) {
  let endpoint;
  try { endpoint = new URL(validProviderBaseUrl(baseUrl, "模型能力检测")); }
  catch { throw new Error("模型能力检测需要有效的 Provider Base URL"); }
  if (!isValidCustomProviderApiKey(apiKey)) throw new Error("模型能力检测需要有效 API Key");
  if (!validModelId(model)) throw new Error("模型能力检测需要有效模型 ID");
  if (upstreamWireApi !== "responses" && upstreamWireApi !== "chat_completions") throw new Error("模型能力检测不支持此上游协议");
  if (!capabilityNames.includes(capability)) throw new Error("模型能力检测仅支持 apply_patch、tool_search 或 web_search 单项探测");
  if (!reasoningEfforts.includes(reasoningEffort) && !(requestContext && (reasoningEffort === null || reasoningEffort === "enabled" && requestContext.clinePass))) throw new Error("模型能力检测需要有效思考强度");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 45000) throw new Error("模型能力检测总预算必须在 1 到 45000 毫秒之间");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/${upstreamWireApi === "responses" ? "responses" : "chat/completions"}`;
  let check;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let selector;
  let dispatcher;
  let requests = 0;
  const abort = () => { controller.abort(); void selector?.close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(abort, timeoutMs);
  if (signal?.aborted) abort();
  const add = result => {
    check = {capability, status: result.status, reason: result.reason, ...(result.httpStatus === undefined ? {} : {httpStatus: result.httpStatus})};
  };
  const unknown = reason => ({status: "inconclusive", reason});
  const good = (reason, response) => ({status: "supported", reason, httpStatus: response.httpStatus});
  const failedTask = response => ({status: "inconclusive", reason: "本次短任务的输出或工具关联未通过验证", httpStatus: response.httpStatus});
  const request = async source => {
    if (controller.signal.aborted || performance.now() >= deadline) return unknown(signal?.aborted ? "模型能力检测已取消" : "模型能力检测总预算已耗尽");
    if (requests >= (capability === "webSearch" ? 1 : maximumRequests)) return unknown("模型能力检测请求次数已达到上限");
    const requestController = new AbortController();
    const forwardAbort = () => requestController.abort();
    controller.signal.addEventListener("abort", forwardAbort, {once: true});
    const requestTimer = setTimeout(forwardAbort, Math.min(capability === "webSearch" ? timeoutMs : 15000, Math.max(1, deadline - performance.now())));
    let httpStatus;
    try {
      const stream = capability === "webSearch";
      let payload = {...source, ...(reasoningEffort === null ? {} : {reasoning: {effort: reasoningEffort}}), model, store: false, stream, max_output_tokens: 768,
        ...(requestContext?.sampling ?? {})};
      if (requestContext?.chatgpt) {
        delete payload.max_output_tokens;
        payload.instructions = "Complete the requested short diagnostic task.";
      }
      let identities;
      if (upstreamWireApi === "chat_completions") {
        const converted = responsesToChat({...payload, stream: true}, requestContext?.reasoningEfforts,
          requestContext?.clinePass ? {clinePass: true} : {structuredOutputWithTools: "prompt"});
        payload = {...converted.request, stream};
        if (requestContext?.clinePass) {
          const {reasoning, ...parameters} = payload;
          payload = pinClinePassRouting(reasoning ? {...parameters, ...clinePassChatReasoningControl(model, reasoning.effort, requestContext.clineRequestProfile)} : parameters, requestContext.clineRequestProfile);
        }
        if (!stream) delete payload.stream_options;
        identities = converted.toolNames;
      }
      requests += 1;
      const response = await undiciFetch(endpoint, {
        method: "POST", headers: {"content-type": "application/json", accept: stream ? "text/event-stream" : "application/json",
          "accept-encoding": "identity", authorization: `Bearer ${apiKey}`, ...(requestContext?.headers ?? {})},
        body: JSON.stringify(payload), signal: requestController.signal, redirect: "error",
        ...(dispatcher === undefined ? {} : {dispatcher}),
      });
      httpStatus = response.status;
      const body = await readBoundedBody(response, requestController,
        httpStatus === 200 && stream && /^text\/event-stream(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") ?? "") ? upstreamWireApi : undefined);
      requestController.signal.throwIfAborted();
      if (body === undefined) return {status: "inconclusive", reason: "上游响应超过模型能力检测大小限制", httpStatus};
      if (httpStatus === 200 && stream) return {...parseWebSearchStream(body, response.headers.get("content-type"), upstreamWireApi, model), httpStatus};
      let parsed;
      try { parsed = JSON.parse(body); } catch { return {status: "inconclusive", reason: "上游未返回有效 JSON", httpStatus}; }
      if (httpStatus !== 200) return classifyHttp(httpStatus, parsed, capability);
      const output = upstreamWireApi === "responses" ? parseResponses(parsed) : parseChat(parsed, identities);
      if (!output) return {status: "inconclusive", reason: "上游未返回完整且可验证的模型响应", httpStatus};
      return {...output, httpStatus};
    } catch {
      return {status: "inconclusive", reason: signal?.aborted ? "模型能力检测已取消"
        : requestController.signal.aborted ? "模型能力检测请求超时"
          : httpStatus === undefined ? "模型能力检测网络、TLS、代理或请求转换失败" : "模型能力检测响应读取失败",
      ...(httpStatus === undefined ? {} : {httpStatus})};
    } finally {
      clearTimeout(requestTimer);
      controller.signal.removeEventListener("abort", forwardAbort);
      requestController.abort();
    }
  };
  const exactText = (response, expected) => response.status === "ok" && response.calls.length === 0 && response.text.trim() === expected;
  const toolsFor = (name, property) => ({type: "function", name, description: "Return a private simulated marker.",
    parameters: {type: "object", properties: {[property]: {type: "string"}}, required: [property], additionalProperties: false}, strict: true});
  const callable = (response, name, property, expected) => {
    if (response.status !== "ok" || response.calls.length !== 1) return undefined;
    const call = response.calls[0];
    if (call.type !== "function_call" || call.name !== name || call.namespace != null) return undefined;
    const args = parseArguments(call.arguments);
    return isObject(args) && Object.keys(args).length === 1 && args[property] === expected ? call : undefined;
  };
  try {
    controller.signal.throwIfAborted();
    selector = createRefreshableHttpProxySelector(readCodexProxySettings(environment), environment);
    const discoveryTimer = setTimeout(abort, Math.min(15000, timeoutMs));
    let proxyUrl;
    try { proxyUrl = await selector.select(endpoint); } finally { clearTimeout(discoveryTimer); }
    controller.signal.throwIfAborted();
    if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl);
    if (capability === "applyPatch") {
      const patchToken = marker();
      const patch = `*** Begin Patch\n*** Add File: capability_probe.txt\n+${patchToken}\n*** End Patch`;
      const patchTool = {type: "custom", name: "apply_patch", description: "Return a patch for a simulated file. No file will be written.", format: {type: "grammar", syntax: "lark", definition: patchGrammar}};
      const patchInput = [message(`Call apply_patch with precisely this patch; do not wrap it in markdown:\n${patch}\nAfter the simulated result, reply with exactly its marker.`)];
      const patchCall = await request({input: patchInput, tools: [patchTool], tool_choice: {type: "custom", name: "apply_patch"}});
      if (patchCall.status !== "ok") add(patchCall);
      else {
        const call = patchCall.calls[0];
        if (patchCall.calls.length !== 1 || call.type !== "custom_tool_call" || call.name !== "apply_patch" || call.namespace != null || call.input.replace(/\n$/u, "") !== patch) add(failedTask(patchCall));
        else {
          const resultToken = marker();
          const last = await request({input: [...patchInput, ...patchCall.output, {type: "custom_tool_call_output", call_id: call.call_id, output: resultToken}], tools: [patchTool], tool_choice: "none"});
          add(last.status !== "ok" ? last : exactText(last, resultToken)
            ? good(upstreamWireApi === "responses" ? "自由格式补丁调用及模拟结果回传已通过；未执行补丁" : "经 Chat 桥的 input 函数补丁调用及模拟结果回传已通过；未执行补丁", last) : failedTask(last));
        }
      }
    } else if (capability === "webSearch") {
      add(await request({
        input: [message("Use the native web_search tool to search the web for the current UTC date and one current news headline. Return a brief answer with a source URL. Do not answer from memory.")],
        tools: [{type: "web_search", external_web_access: true}], tool_choice: "auto",
      }));
    } else {
      const discovered = {...toolsFor("lookup_probe_marker", "key"), defer_loading: true};
      const searchInput = [message("Call tool_search with query lookup_probe_marker and limit 1, then call the discovered tool with key K7. Reply only with its final marker.")];
      const search = await request({input: searchInput, tools: [searchTool], tool_choice: "required", parallel_tool_calls: false});
      if (search.status !== "ok") add(search);
      else {
        const call = search.calls[0];
        if (search.calls.length !== 1 || call.type !== "tool_search_call" || call.execution !== "client" || !isObject(call.arguments)
          || typeof call.arguments.query !== "string" || !call.arguments.query.includes(discovered.name)
          || (call.arguments.limit != null && call.arguments.limit !== 1)
          || Object.keys(call.arguments).some(key => key !== "query" && key !== "limit")) add(failedTask(search));
        else {
          const history = [...searchInput, ...search.output, {type: "tool_search_output", call_id: call.call_id, status: "completed", execution: "client", tools: [discovered]}];
          // 与 Codex 一致：发现工具只经检索结果提供；Chat 转换层从历史中补入函数声明。
          const found = await request({input: history, tools: [searchTool], tool_choice: "auto", parallel_tool_calls: false});
          if (found.status !== "ok") add(found);
          else {
            const foundCall = callable(found, discovered.name, "key", "K7");
            if (!foundCall) add(failedTask(found));
            else {
              const token = marker();
              const last = await request({input: [...history, ...found.output, {type: "function_call_output", call_id: foundCall.call_id, output: token}], tools: [searchTool], tool_choice: "none"});
              add(last.status !== "ok" ? last : exactText(last, token)
                ? good(upstreamWireApi === "responses" ? "客户端检索、发现工具调用及模拟结果回传已通过" : "经 Chat 桥函数映射的客户端检索、发现工具调用及结果回传已通过", last) : failedTask(last));
            }
          }
        }
      }
    }
  } catch {
    add(unknown(signal?.aborted ? "模型能力检测已取消" : controller.signal.aborted ? "模型能力检测总预算或代理发现预算已耗尽" : "模型能力检测代理配置或发现失败"));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    await dispatcher?.destroy().catch(() => undefined);
    await selector?.close().catch(() => undefined);
  }
  const cancelled = signal?.aborted === true;
  if (cancelled) add(unknown("模型能力检测已取消"));
  return {model, upstreamWireApi, capability, reasoningEffort, status: cancelled ? "cancelled" : "completed", check};
}

async function readBoundedBody(response, controller, streamProtocol) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString("utf8");
      size += value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
      controller.signal.throwIfAborted();
      if (streamProtocol !== undefined) {
        const body = Buffer.concat(chunks, size).toString("utf8").replace(/\r\n|\r/gu, "\n");
        const boundary = body.lastIndexOf("\n\n");
        if (boundary >= 0) {
          const complete = body.slice(0, boundary + 2);
          const frames = readProbeEvents(complete);
          const terminal = frames?.some(frame => {
            if (streamProtocol === "chat_completions") return frame.data === "[DONE]";
            try { return ["response.completed", "response.failed", "response.incomplete", "error", "stream_error"].includes(JSON.parse(frame.data)?.type); }
            catch { return false; }
          });
          if (terminal) {
            await reader.cancel().catch(() => undefined);
            return complete;
          }
        }
      }
    }
  } finally { reader.releaseLock(); }
}

function classifyHttp(httpStatus, parsed, capability) {
  if (httpStatus === 401 || httpStatus === 403) return {status: "inconclusive", reason: "模型能力检测认证或权限失败", httpStatus};
  if (httpStatus === 429) return {status: "inconclusive", reason: "模型能力检测受到上游限流", httpStatus};
  if (capability === "webSearch") return {status: [400, 404, 422].includes(httpStatus) && rejectsWebSearch(parsed) ? "unsupported" : "inconclusive",
    reason: [400, 404, 422].includes(httpStatus) && rejectsWebSearch(parsed) ? "上游明确拒绝原生 web_search 工具或参数" : "上游拒绝请求，无法确认本项能力", httpStatus};
  const error = isObject(parsed) ? parsed.error : undefined;
  const context = typeof error === "string" ? error : isObject(error) ? [error.param, error.code, error.message].filter(value => typeof value === "string").join(" ") : "";
  const relevant = {applyPatch: /\b(?:apply_patch|custom|grammar|freeform)\b/iu,
    toolSearch: /\btool_search(?:_call|_output)?\b/iu}[capability];
  return {status: [400, 404, 422].includes(httpStatus) && relevant.test(context) ? "unsupported" : "inconclusive",
    reason: [400, 404, 422].includes(httpStatus) && relevant.test(context) ? "上游明确拒绝本项检测使用的输入或参数" : "上游拒绝请求，无法确认本项能力", httpStatus};
}

function rejectsWebSearch(value) {
  const error = isObject(value) ? value.error ?? value.response?.error ?? value : value;
  const context = typeof error === "string" ? error : isObject(error)
    ? [error.param, error.code, error.message].filter(part => typeof part === "string").join(" ") : "";
  // 必须明确指向原生工具；例如额度、思考参数或认证错误中提及 web_search 不代表工具不受支持。
  const target = "(?:web_search|external_web_access)";
  const rejection = "(?:unsupported|unknown|unrecognized|disallowed|not[ _-]+supported|not[ _-]+allowed|does[ _-]+not[ _-]+support|cannot[ _-]+support|invalid[ _-]+(?:tool|parameter|value|type))";
  const connector = "(?:[ :\"'`_-]|the\\b|native\\b|tool\\b|parameter\\b|type\\b|value\\b|is\\b|are\\b){0,80}";
  return new RegExp(`\\b${rejection}\\b${connector}\\b${target}\\b|\\b${target}\\b${connector}\\b${rejection}\\b`, "iu").test(context)
    || /(?:不支持|不允许|未知|无法识别)[ ：“”"'的原生工具参数]*(?:web_search|external_web_access)|(?:web_search|external_web_access)[ ：“”"'的原生工具参数]*(?:不支持|不允许|未知|无法识别)/iu.test(context);
}

/** 正文已由 readBoundedBody 限制到 128KiB；只接受以空行提交的完整 SSE 事件。 */
function readProbeEvents(body) {
  const events = [];
  let event = "";
  let data = [];
  const lines = body.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u);
  if (/[\r\n]$/u.test(body)) lines.pop();
  for (const line of lines) {
    if (line === "") {
      if (data.length) events.push({event, data: data.join("\n")});
      event = ""; data = [];
    } else if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
  }
  return data.length || event ? undefined : events;
}

function parseWebSearchStream(body, contentType, upstreamWireApi, requestedModel) {
  const invalid = () => ({status: "inconclusive", reason: "上游未返回完整且可验证的流式响应"});
  if (!/^text\/event-stream(?:\s*;|\s*$)/iu.test(contentType ?? "")) return invalid();
  const events = readProbeEvents(body);
  if (!events?.length) return invalid();
  const chat = upstreamWireApi === "chat_completions" ? new DirectChatResponse() : undefined;
  let completed;
  let done = false;
  try {
    for (const frame of events) {
      if (frame.data === "[DONE]") {
        if (done || (!chat && !completed)) return invalid();
        chat?.finish();
        done = true;
        continue;
      }
      let value;
      try { value = JSON.parse(frame.data); } catch { return invalid(); }
      if (!isObject(value)) return invalid();
      if (["error", "stream_error", "response.failed"].includes(frame.event)
        || ["error", "stream_error", "response.failed"].includes(value.type) || value.error != null || value.response?.error != null) {
        return rejectsWebSearch(value)
          ? {status: "unsupported", reason: "上游明确拒绝原生 web_search 工具或参数"}
          : {status: "inconclusive", reason: "上游返回流内错误，无法确认原生 web_search 能力"};
      }
      if (done) return invalid();
      if (chat) {
        chat.push(value, true);
      } else {
        if (typeof value.type !== "string" || frame.event && frame.event !== value.type) return invalid();
        if (completed || value.type === "response.incomplete") return invalid();
        if (value.type === "response.completed") {
          if (value.response?.model !== requestedModel) return invalid();
          completed = parseResponses(value.response, true);
          if (!completed) return invalid();
        }
      }
    }
    if (chat ? !done || chat.status !== "completed" : !completed) return invalid();
    return completed?.calls.some(call => call.type === "web_search_call" && call.action.type === "search")
      ? {status: "supported", reason: "已收到完成的 web_search_call 搜索事件"}
      : {status: "inconclusive", reason: "请求已完成，但未取得原生 web_search 搜索执行证据"};
  } catch { return invalid(); }
}

function parseArguments(value) {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function parseResponses(value, allowWebSearch = false) {
  if (!isObject(value) || value.error != null || value.object !== "response" || !validModelId(value.model) || value.status !== "completed" || !Array.isArray(value.output)) return undefined;
  const calls = [];
  const ids = new Set();
  let text = "";
  for (const item of value.output) {
    if (!isObject(item)) return undefined;
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content) || (item.status != null && item.status !== "completed")) return undefined;
      for (const part of item.content) {
        if (!isObject(part) || part.type !== "output_text" || typeof part.text !== "string") return undefined;
        text += part.text;
      }
    } else if (item.type === "reasoning") {
      for (const part of [...(item.summary ?? []), ...(item.content ?? [])]) {
        if (!isObject(part) || !["summary_text", "reasoning_text"].includes(part.type) || typeof part.text !== "string") return undefined;
      }
    } else if (allowWebSearch && item.type === "web_search_call") {
      if (item.status !== "completed" || !isObject(item.action) || !["search", "open_page", "find_in_page"].includes(item.action.type)) return undefined;
      if (item.id != null && (typeof item.id !== "string" || !item.id || ids.has(item.id))) return undefined;
      if (item.action.query != null && typeof item.action.query !== "string") return undefined;
      if (item.action.queries != null && (!Array.isArray(item.action.queries) || item.action.queries.some(query => typeof query !== "string"))) return undefined;
      if (item.id != null) ids.add(item.id);
      calls.push(item);
    } else if (["function_call", "custom_tool_call", "tool_search_call"].includes(item.type)) {
      if (typeof item.call_id !== "string" || !item.call_id || ids.has(item.call_id) || (item.status != null && item.status !== "completed")) return undefined;
      if (item.type === "function_call" && (typeof item.name !== "string" || !isObject(parseArguments(item.arguments)))) return undefined;
      if (item.type === "custom_tool_call" && (typeof item.name !== "string" || typeof item.input !== "string")) return undefined;
      if (item.type === "tool_search_call" && (item.execution !== "client" || !isObject(item.arguments))) return undefined;
      ids.add(item.call_id); calls.push(item);
    } else return undefined;
  }
  return {status: "ok", output: value.output, text, calls};
}

function parseChat(value, identities) {
  if (!isObject(value) || value.error != null || value.object !== "chat.completion" || !validModelId(value.model) || !Array.isArray(value.choices) || value.choices.length !== 1) return undefined;
  const choice = value.choices[0];
  if (!isObject(choice) || !["stop", "tool_calls"].includes(choice.finish_reason) || !isObject(choice.message) || choice.message.role !== "assistant") return undefined;
  const msg = choice.message;
  if (msg.content != null && typeof msg.content !== "string") return undefined;
  if (msg.refusal != null || msg.function_call != null || (msg.tool_calls != null && !Array.isArray(msg.tool_calls))) return undefined;
  const output = [];
  if ((msg.reasoning != null && typeof msg.reasoning !== "string") || (msg.reasoning_content != null && typeof msg.reasoning_content !== "string")) return undefined;
  let details = "";
  if (msg.reasoning_details != null) {
    if (!Array.isArray(msg.reasoning_details)) return undefined;
    for (const detail of msg.reasoning_details) {
      if (!isObject(detail) || detail.type !== "reasoning.text" || detail.signature != null || detail.data != null || typeof detail.text !== "string") return undefined;
      details += detail.text;
    }
  }
  // 与共享 Chat 桥一致：重复明文只保留一次，冲突和带签名内容明确拒绝。
  const thoughts = [msg.reasoning ?? "", msg.reasoning_content ?? "", details].filter(value => value !== "");
  if (new Set(thoughts).size > 1) return undefined;
  const thought = thoughts[0] ?? "";
  if (thought) {
    output.push(msg.reasoning_content ? {type: "reasoning", content: [{type: "reasoning_text", text: thought}], summary: []}
      : {type: "reasoning", summary: [{type: "summary_text", text: thought}]});
  }
  const text = msg.content ?? "";
  if (text) output.push({type: "message", role: "assistant", content: [{type: "output_text", text}]});
  const calls = [];
  const ids = new Set();
  for (const call of msg.tool_calls ?? []) {
    if (!isObject(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || ids.has(call.id) || !isObject(call.function)) return undefined;
    const identity = identities?.get(call.function.name);
    const args = parseArguments(call.function.arguments);
    if (!identity || !isObject(args)) return undefined;
    const common = {call_id: call.id, name: identity.name, ...(identity.namespace === undefined ? {} : {namespace: identity.namespace})};
    let item;
    if (identity.kind === "custom") {
      if (Object.keys(args).length !== 1 || typeof args.input !== "string") return undefined;
      item = {type: "custom_tool_call", ...common, input: args.input};
    } else if (identity.kind === "tool_search") item = {type: "tool_search_call", call_id: call.id, execution: "client", arguments: args};
    else item = {type: "function_call", ...common, arguments: call.function.arguments};
    ids.add(call.id); output.push(item); calls.push(item);
  }
  if ((calls.length > 0) !== (choice.finish_reason === "tool_calls")) return undefined;
  return {status: "ok", output, text, calls};
}
