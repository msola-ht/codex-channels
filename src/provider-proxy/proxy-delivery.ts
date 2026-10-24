import type { ServerResponse } from "node:http";
import WebSocket, { type RawData } from "ws";
import { ModelRequestTimeoutError } from "./chat-errors.js";

/** A stage deadline releases its waiter even when an injected callback ignores cancellation. */
export function waitForProxyOperation<T>(pending: Promise<T>, signal: AbortSignal, timeoutMs: number, stage: "delivery" | "terminal"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failed(new ModelRequestTimeoutError(stage)), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    const failed = (error: unknown): void => { cleanup(); reject(error instanceof Error ? error : new Error("模型请求失败")); };
    const aborted = (): void => failed(signal.reason ?? new Error("模型请求已取消"));
    void pending.then(value => { cleanup(); resolve(value); }, failed);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Bound downstream drain waiting; synchronous writes need no timer. */
export async function writeResponseChunk(response: ServerResponse, data: string | Buffer, signal: AbortSignal, timeoutMs: number, backpressure?: () => void, stage: "delivery" | "terminal" = "delivery"): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed || response.writableEnded) throw new Error("Response disconnected");
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer); response.off("drain", drain); response.off("close", close); response.off("error", error);
      signal.removeEventListener("abort", abort);
    };
    const error = (reason: unknown): void => {
      if (settled) return;
      settled = true; cleanup(); reject(reason instanceof Error ? reason : new Error("Response disconnected"));
    };
    const drain = (): void => { if (!settled) { settled = true; cleanup(); resolve(); } };
    const close = (): void => error(new Error("Response disconnected"));
    const abort = (): void => error(signal.reason);
    response.once("drain", drain); response.once("close", close); response.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (response.write(data)) drain();
      else {
        backpressure?.();
        if (!settled) timer = setTimeout(() => error(new ModelRequestTimeoutError(stage)), timeoutMs);
      }
    } catch (reason) { error(reason); }
  });
}

export function finishProxyResponse(response: ServerResponse, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return waitForDelivery(response, signal, timeoutMs, "finish", () => { response.end(); return response.writableFinished; }, "terminal");
}

function waitForDelivery(response: ServerResponse, signal: AbortSignal, timeoutMs: number, event: "drain" | "finish", submit: () => boolean, stage: "delivery" | "terminal"): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failed(new ModelRequestTimeoutError(stage)), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      response.off(event, completed); response.off("close", closed); response.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const completed = (): void => { cleanup(); resolve(); };
    const failed = (error: unknown): void => { cleanup(); reject(error instanceof Error ? error : new Error("模型响应交付失败")); };
    const closed = (): void => failed(new Error("模型响应交付连接已关闭"));
    const aborted = (): void => failed(signal.reason ?? new Error("模型响应交付已取消"));
    if (signal.aborted) { aborted(); return; }
    if (response.destroyed || response.writableEnded) { closed(); return; }
    response.once(event, completed); response.once("close", closed); response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    try { if (submit()) completed(); } catch (error) { failed(error); }
  });
}

export function sendProxyWebSocket(target: WebSocket, data: RawData | string, isBinary: boolean, signal: AbortSignal, timeoutMs: number, backpressure?: () => void, stage: "delivery" | "terminal" = "delivery", submitted?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failed(new ModelRequestTimeoutError(stage)), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      target.off("close", closed); target.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = (error: unknown): void => { cleanup(); reject(error instanceof Error ? error : new Error("模型 WebSocket 交付失败")); };
    const closed = (): void => failed(new Error("模型 WebSocket 交付连接已关闭"));
    const aborted = (): void => failed(signal.reason ?? new Error("模型 WebSocket 交付已取消"));
    if (signal.aborted) { aborted(); return; }
    if (target.readyState !== WebSocket.OPEN) { closed(); return; }
    target.once("close", closed); target.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      target.send(data, { binary: isBinary }, error => {
        if (error) failed(error);
        else { cleanup(); resolve(); }
      });
      submitted?.();
      if (target.bufferedAmount > 0) backpressure?.();
    } catch (error) { failed(error); }
  });
}
