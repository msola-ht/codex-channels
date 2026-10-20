import { managementSecurityHeaders } from "./management-security.mjs";
import { ApiError } from "./webui-http.mjs";
const streams = new WeakMap();
export function closeQueueStreams(state) {
  let owned = streams.get(state);
  if (!owned) { owned = { active: new Set(), closed: true }; streams.set(state, owned); }
  owned.closed = true;
  const active = [...owned.active];
  for (const stream of active) stream.close();
  return Promise.all(active.map(stream => stream.task)).then(() => undefined);
}
export function openQueueStream(state, response, watch) {
  let owned = streams.get(state);
  if (!owned) { owned = { active: new Set(), closed: false }; streams.set(state, owned); }
  if (owned.closed) throw new ApiError(503, "delivery_busy", "队列通知正在关闭");
  const active = owned.active;
  if (active.size >= 8) throw new ApiError(429, "delivery_busy", "队列通知连接已满");
  const controller = new AbortController();
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    response.end();
  };
  const stream = { close, task: undefined };
  active.add(stream);
  response.once("close", close);
  const send = type => {
    if (controller.signal.aborted) return;
    if (!response.write(`data: ${JSON.stringify({ type })}\n\n`)) { close(); response.destroy(); }
  };
  stream.task = Promise.resolve().then(() => {
    if (controller.signal.aborted) return;
    response.writeHead(200, { ...managementSecurityHeaders(), "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    response.flushHeaders();
    return watch(controller.signal, send);
  }).catch(() => send("unavailable")).finally(() => {
    close();
    response.off("close", close);
    active.delete(stream);
  });
  if (response.destroyed) close();
}
