import type { IncomingMessage, ServerResponse } from "node:http";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";
import { ModelConversionError } from "../model-api/index.js";
import { ChatUpstreamError, ModelRequestTimeoutError } from "./chat-errors.js";
import { writeResponseChunk } from "./proxy-delivery.js";

export class ChatBodyTooLargeError extends ModelConversionError {}
export class ChatBodyEncodingError extends ModelConversionError {}

/** Detach cancelled preparation; a late resolver can no longer advance the request. */
export function waitForChatOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("Request cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Pause an unfinished upload on error so the owner can still send a safe HTTP response. */
export async function readChatBody(request: IncomingMessage, signal: AbortSignal, maximumBytes: number): Promise<string> {
  const body = await readModelBody(request, signal, maximumBytes);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
  catch { throw new ChatBodyEncodingError("Model request contains invalid UTF-8"); }
}

export function readModelBody(request: IncomingMessage, signal: AbortSignal, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", data); request.off("end", end); request.off("error", error);
      request.off("aborted", abort); signal.removeEventListener("abort", abort);
    };
    const error = (reason: unknown): void => {
      cleanup(); request.pause(); chunks.length = 0; reject(reason instanceof Error ? reason : new Error("Request cancelled"));
    };
    const abort = (): void => error(signal.reason);
    const end = (): void => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximumBytes) error(new ChatBodyTooLargeError("Model request exceeds size limit"));
      else chunks.push(chunk);
    };
    if (signal.aborted || request.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", abort);
  });
}

export function writeChatData(response: ServerResponse, data: string, signal: AbortSignal, backpressure?: () => void, timeoutMs: number = modelRequestPolicy.deliveryTimeoutMs, stage: "delivery" | "terminal" = "delivery"): Promise<void> {
  return writeResponseChunk(response, data, signal, timeoutMs, backpressure, stage);
}

export interface ChatStreamBounds {
  frameBytes: number;
  bufferBytes: number;
  totalBytes: number;
  /** Existing bridge contract counts UTF-16 code units; Relay uses byte limits. */
  bufferCharacters?: number;
}

/** Pull-based decoding keeps downstream backpressure attached to the upstream reader. */
export async function* readModelFrames(incoming: IncomingMessage, signal: AbortSignal, bounds: ChatStreamBounds): AsyncGenerator<{ data: string; raw: string; receivedAt: number }> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decode = (chunk?: Buffer): string => {
    try { return decoder.decode(chunk, { stream: chunk !== undefined }); }
    catch { throw new ChatUpstreamError("invalid_upstream_encoding", "Upstream response contains invalid UTF-8.", false); }
  };
  let buffer = "";
  let total = 0;
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const abort = (): void => { incoming.destroy(); };
  const arm = (): void => {
    timeout = setTimeout(() => { timedOut = true; incoming.destroy(); }, modelRequestPolicy.streamIdleTimeoutMs);
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  arm();
  try {
    for await (const value of incoming) {
      const receivedAt = performance.now();
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
      total += chunk.length;
      if (total > bounds.totalBytes) throw new ModelConversionError("Chat response exceeds size limit");
      buffer += decode(chunk);
      if (bounds.bufferCharacters !== undefined && buffer.length > bounds.bufferCharacters) throw new ModelConversionError("Chat buffer exceeds size limit");
      if (Buffer.byteLength(buffer) > bounds.bufferBytes) throw new ModelConversionError("Chat buffer exceeds size limit");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (Buffer.byteLength(frame) > bounds.frameBytes) throw new ModelConversionError("Chat frame exceeds size limit");
        const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /u, "")).join("\n");
        if (data === "[DONE]" && /(?:^|\r?\n)data:/u.test(buffer)) throw new ModelConversionError("Chat data follows DONE");
        if (data) {
          clearTimeout(timeout);
          yield { data, raw: frame, receivedAt };
          signal.throwIfAborted();
          arm();
        }
      }
      if (Buffer.byteLength(buffer) > bounds.frameBytes) throw new ModelConversionError("Chat frame exceeds size limit");
    }
    buffer += decode();
    signal.throwIfAborted();
    if (timedOut) throw new ModelRequestTimeoutError("stream");
    if (buffer.trim()) throw new ModelConversionError("Chat stream has an incomplete frame");
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (timedOut) throw new ModelRequestTimeoutError("stream");
    throw error;
  } finally {
    clearTimeout(timeout); signal.removeEventListener("abort", abort);
    if (!incoming.readableEnded) incoming.destroy();
  }
}
