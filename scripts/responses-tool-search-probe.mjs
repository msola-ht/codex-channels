import { fetch as undiciFetch, ProxyAgent } from "undici";

import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { createRefreshableHttpProxySelector } from "../runtime/network-proxy.mjs";
import { validProviderBaseUrl } from "../runtime/model-provider-runtime.mjs";

const maximumResponseBytes = 4096;

const toolSearchDeclaration = {
  type: "tool_search",
  execution: "client",
  description: "Search for additional tools that are not declared inline.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    required: ["query"],
  },
};

const discoveredProbeTool = {
  type: "function",
  name: "probe_discovered_tool",
  description: "Placeholder tool returned by the probe search result.",
  parameters: { type: "object", properties: {} },
};

/**
 * 探测第三方 Responses 上游是否接受 Codex 客户端的 tool_search 输入项。
 * 只按状态分类返回固定原因，不回传上游正文；结论只覆盖本次极短请求。
 */
export async function probeResponsesToolSearch({baseUrl, apiKey, model, environment = process.env, signal, timeoutMs = 15000}) {
  const endpoint = new URL(validProviderBaseUrl(baseUrl, "工具检索检测"));
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/u.test(apiKey)) throw new Error("工具检索检测需要有效 API Key");
  if (typeof model !== "string" || !model.trim()) throw new Error("工具检索检测需要模型 ID");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("工具检索检测超时必须是有效正整数毫秒");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/responses`;
  if (signal?.aborted) return {status: "cancelled", reason: "已取消检测"};

  const controller = new AbortController();
  let selector;
  const abort = () => {
    controller.abort();
    void selector?.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(abort, timeoutMs);
  let dispatcher;
  let httpStatus;
  try {
    selector = createRefreshableHttpProxySelector(readCodexProxySettings(environment), environment);
    const proxyUrl = await selector.select(endpoint);
    controller.signal.throwIfAborted();
    if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl);
    const response = await undiciFetch(endpoint, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${apiKey}`},
      body: JSON.stringify(probeBody(model)),
      signal: controller.signal,
      redirect: "error",
      ...(dispatcher === undefined ? {} : {dispatcher}),
    });
    httpStatus = response.status;
    const body = await readResponseBody(response);
    controller.signal.throwIfAborted();
    if (body === undefined) return {status: "inconclusive", reason: "上游响应超过检测大小限制，无法确认工具检索兼容性", httpStatus};
    return classifyResponse(response.status, body);
  } catch {
    if (signal?.aborted) return {status: "cancelled", reason: "已取消检测"};
    if (controller.signal.aborted) return {status: "inconclusive", reason: "检测超时，无法确认工具检索兼容性"};
    if (httpStatus !== undefined) return {status: "inconclusive", reason: "上游响应正文读取失败，无法确认工具检索兼容性", httpStatus};
    return {status: "inconclusive", reason: "网络、TLS 或代理失败，无法确认工具检索兼容性"};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    await dispatcher?.destroy().catch(() => undefined);
    await selector?.close();
  }
}

async function readResponseBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return Buffer.concat(chunks, bytes).toString("utf8");
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function probeBody(model) {
  return {
    model,
    instructions: "Tool search compatibility probe.",
    input: [
      {type: "message", role: "user", content: [{type: "input_text", text: "Reply with exactly OK."}]},
      {type: "tool_search_call", id: "ts_probe", call_id: "call_probe", status: "completed", execution: "client",
        arguments: {query: "probe", limit: 1}},
      {type: "tool_search_output", call_id: "call_probe", status: "completed", execution: "client", tools: [discoveredProbeTool]},
      {type: "message", role: "user", content: [{type: "input_text", text: "Reply with exactly OK."}]},
    ],
    tools: [toolSearchDeclaration, discoveredProbeTool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: false,
    max_output_tokens: 16,
  };
}

function classifyResponse(status, body) {
  if (status >= 200 && status < 300) {
    const parsed = parseResponseObject(body);
    if (!parsed) return {status: "inconclusive", reason: "上游未返回有效 JSON 响应，无法确认工具检索兼容性", httpStatus: status};
    if (parsed.error !== null && parsed.error !== undefined) return {status: "inconclusive", reason: "上游以 HTTP 2xx 返回错误正文，无法确认工具检索兼容性", httpStatus: status};
    if (parsed.object !== "response" || !Array.isArray(parsed.output)
      || (parsed.status !== "completed" && parsed.status !== "incomplete")) {
      return {status: "inconclusive", reason: "上游未返回已结束的 Responses 结果，无法确认工具检索兼容性", httpStatus: status};
    }
    return {status: "supported", reason: "上游接受 Codex 的 tool_search 输入项", httpStatus: status};
  }
  if (status === 401 || status === 403) return {status: "inconclusive", reason: "认证或权限检查失败", httpStatus: status};
  if (status === 429) return {status: "inconclusive", reason: "平台限流，请稍后重试", httpStatus: status};
  if (status === 400 || status === 404 || status === 422) {
    return mentionsToolSearch(body)
      ? {status: "unsupported", reason: "上游不接受 Codex 的 tool_search 输入项", httpStatus: status}
      : {status: "inconclusive", reason: "上游拒绝请求，但原因与工具检索无关，无法确认", httpStatus: status};
  }
  return {status: "inconclusive", reason: "平台返回错误，无法确认工具检索兼容性", httpStatus: status};
}

/** 上游正文只用于分类，不进入用户可见内容。 */
function mentionsToolSearch(body) {
  const parsed = parseResponseObject(body);
  if (!parsed) return /\btool_search(?:_call|_output)?\b/iu.test(body);
  const error = parsed.error;
  if (typeof error === "string") return /\btool_search(?:_call|_output)?\b/iu.test(error);
  if (error === null || typeof error !== "object") return false;
  return [error.message, error.param, error.code].some(value => typeof value === "string" && /\btool_search(?:_call|_output)?\b/iu.test(value));
}

function parseResponseObject(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
