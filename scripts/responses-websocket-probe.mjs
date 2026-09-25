import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { createRefreshableHttpProxySelector } from "../runtime/network-proxy.mjs";
import { validProviderBaseUrl } from "../runtime/model-provider-runtime.mjs";

// Codex rust-v0.156.1: core/src/client.rs and codex-api/src/common.rs.
export async function probeResponsesWebSocket({baseUrl, apiKey, model, reasoningEffort = "none", mode = "prewarm", environment = process.env, signal, timeoutMs = 15000}) {
  if (!["prewarm", "generate"].includes(mode)) throw new Error("WS 检测模式无效");
  const endpoint = new URL(validProviderBaseUrl(baseUrl, "WS 检测"));
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/u.test(apiKey)) throw new Error("WS 检测需要有效 API Key");
  if (typeof model !== "string" || !model.trim()) throw new Error("WS 检测需要模型 ID");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/responses`;
  const selector = createRefreshableHttpProxySelector(readCodexProxySettings(environment), environment);
  let socket;
  let agent;
  let timer;
  let onAbort;
  let finished = false;
  let connected = false;
  let receivedText = false;
  try {
    return await new Promise(resolve => {
      const finish = (status, reason, httpStatus) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({status, reason, connected, ...(httpStatus === undefined ? {} : {httpStatus})});
        socket?.terminate();
      };
      onAbort = () => finish("cancelled", "已取消检测");
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, {once:true});
      timer = setTimeout(() => finish("inconclusive", "检测超时，无法确认 WS 可用性"), timeoutMs);
      void (async () => {
        try {
          const proxy = await selector.select(endpoint);
          if (finished) return;
          if (proxy) agent = new HttpsProxyAgent(proxy);
          endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(endpoint, {
            agent, followRedirects:false, perMessageDeflate:false, maxPayload:1024 * 1024,
            handshakeTimeout:timeoutMs,
            headers:{Authorization:`Bearer ${apiKey}`, "OpenAI-Beta":"responses_websockets=2026-02-06"},
          });
          socket.on("error", () => finish("inconclusive", "网络、TLS 或 WS 连接失败"));
          socket.on("close", () => finish("inconclusive", "WS 在收到有效完成事件前关闭"));
          socket.on("unexpected-response", (request, response) => {
            const status = response.statusCode;
            response.destroy(); request.destroy();
            const reason = status === 401 || status === 403 ? "认证或权限检查失败"
              : status === 429 ? "平台限流，请稍后重试"
              : status === 404 || status === 405 ? "该地址未接受 WS 接口，请核对路径及平台支持情况"
              : "平台未接受 WS 握手";
            finish("inconclusive", reason, status);
          });
          socket.on("open", () => {
            connected = true;
            socket.send(JSON.stringify({
              type:"response.create", model, instructions:"Reply with exactly OK.",
              input:mode === "prewarm" ? [] : [{type:"message",role:"user",content:[{type:"input_text",text:"Reply OK."}]}],
              tools:[], tool_choice:"auto", parallel_tool_calls:false,
              reasoning:{effort:reasoningEffort}, store:false, stream:true, include:[],
              ...(mode === "prewarm" ? {generate:false} : {}),
            }), error => { if (error) finish("inconclusive", "WS 请求发送失败"); });
          });
          socket.on("message", (data, binary) => {
            if (finished) return;
            if (binary) { finish("inconclusive", "平台返回非文本 WS 消息"); return; }
            let event;
            try { event = JSON.parse(data.toString()); } catch { finish("inconclusive", "平台返回无效 JSON"); return; }
            if (event?.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.trim()) receivedText = true;
            if (event?.type === "response.output_item.done" && hasAssistantText(event.item)) receivedText = true;
            if (event?.type === "error" || event?.type === "response.failed" || event?.type === "response.incomplete") {
              finish("inconclusive", "平台拒绝请求或未完成响应，无法确认模型 WS 兼容性");
            } else if (event?.type === "response.completed") {
              const response = event.response;
              if (!response || typeof response.id !== "string" || !response.id || (response.status !== undefined && response.status !== "completed")
                || (response.model !== undefined && response.model !== model)) {
                finish("inconclusive", "完成事件格式或模型与检测请求不一致"); return;
              }
              if (Array.isArray(response.output) && response.output.some(hasAssistantText)) receivedText = true;
              if (mode === "generate" && !receivedText) { finish("inconclusive", "响应流未包含模型文字输出"); return; }
              finish(mode === "prewarm" ? "prewarm" : "verified", mode === "prewarm" ? "WS 握手及预热通过；模型生成尚未验证" : "指定模型的 WS 文字请求已验证；工具和多轮兼容性未验证");
            }
          });
        } catch {
          finish("inconclusive", "代理配置或 WS 连接初始化失败");
        }
      })();
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    socket?.terminate();
    agent?.destroy();
    await selector.close();
  }
}

function hasAssistantText(item) {
  return item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)
    && item.content.some(part => part?.type === "output_text" && typeof part.text === "string" && part.text.trim());
}
