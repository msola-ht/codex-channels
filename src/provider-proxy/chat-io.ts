import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { ModelConversionError } from "../model-api/index.js";

export class ChatBodyTooLargeError extends ModelConversionError {}

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
  return (await readModelBody(request, signal, maximumBytes)).toString("utf8");
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

export async function writeChatData(response: ServerResponse, data: string, signal: AbortSignal, backpressure?: () => void): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed) throw new Error("Response disconnected");
  if (!response.write(data)) {
    backpressure?.();
    await once(response, "drain", { signal });
  }
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
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let total = 0;
  for await (const value of incoming) {
    const receivedAt = performance.now();
    signal.throwIfAborted();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    total += chunk.length;
    if (total > bounds.totalBytes) throw new ModelConversionError("Chat response exceeds size limit");
    buffer += decoder.write(chunk);
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
      if (data) yield { data, raw: frame, receivedAt };
    }
    if (Buffer.byteLength(buffer) > bounds.frameBytes) throw new ModelConversionError("Chat frame exceeds size limit");
  }
  buffer += decoder.end();
  if (buffer.trim()) throw new ModelConversionError("Chat stream has an incomplete frame");
}
