import { fetch as undiciFetch, ProxyAgent } from "undici";

import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { selectHttpProxyUrl } from "../runtime/network-proxy.mjs";
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
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/responses`;
  if (signal?.aborted) return {status: "cancelled", reason: "已取消检测"};

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher;
  try {
    const proxyUrl = selectHttpProxyUrl(readCodexProxySettings(environment), endpoint);
    if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl);
    const response = await undiciFetch(endpoint, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${apiKey}`},
      body: JSON.stringify(probeBody(model)),
      signal: controller.signal,
      ...(dispatcher === undefined ? {} : {dispatcher}),
    });
    const body = (await response.text().catch(() => "")).slice(0, maximumResponseBytes);
    return classifyResponse(response.status, body);
  } catch {
    if (signal?.aborted) return {status: "cancelled", reason: "已取消检测"};
    if (controller.signal.aborted) return {status: "inconclusive", reason: "检测超时，无法确认工具检索兼容性"};
    return {status: "inconclusive", reason: "网络、TLS 或代理失败，无法确认工具检索兼容性"};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await dispatcher?.close().catch(() => undefined);
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
      {type: "tool_search_output", call_id: "call_probe", execution: "client", tools: [discoveredProbeTool]},
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
    if (mentionsError(body)) return {status: "inconclusive", reason: "上游以 HTTP 2xx 返回错误正文，无法确认工具检索兼容性", httpStatus: status};
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
  return /tool_search|unsupported_parameter|unsupported parameter|not supported/iu.test(body);
}

function mentionsError(body) {
  if (body.trim() === "") return false;
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && parsed.error !== null && parsed.error !== undefined;
  } catch {
    return false;
  }
}
