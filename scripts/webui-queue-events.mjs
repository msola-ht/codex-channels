import { managementSecurityHeaders } from "./management-security.mjs";
import { ApiError } from "./webui-http.mjs";
const streams = new WeakMap();
export function closeQueueStreams(state) {
  for (const close of streams.get(state) ?? []) close();
}
export function openQueueStream(state, response, watch) {
  let active = streams.get(state);
  if (!active) { active = new Set(); streams.set(state, active); }
  if (active.size >= 8) throw new ApiError(429, "delivery_busy", "队列通知连接已满");
  const controller = new AbortController();
  const close = () => { controller.abort(); active.delete(close); response.end(); };
  active.add(close);
  response.once("close", close);
  response.writeHead(200, { ...managementSecurityHeaders(), "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
  response.flushHeaders();
  const send = type => {
    if (controller.signal.aborted) return;
    if (!response.write(`data: ${JSON.stringify({ type })}\n\n`)) { close(); response.destroy(); }
  };
  void Promise.resolve().then(() => watch(controller.signal, send)).catch(() => send("unavailable")).finally(() => {
    close();
    response.end();
  });
}
