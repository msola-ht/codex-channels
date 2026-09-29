import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { directChatJson, DirectChatResponse, ModelConversionError, type DirectChatRequest } from "../model-api/index.js";
import { ChatUpstreamError, chatStreamError, chatUpstreamError, readChatHttpError } from "./chat-errors.js";
import { readChatBody, readChatFrames } from "./chat-io.js";
import type { ProviderProxyUpstream } from "./proxy.js";
import { endToEndHeaders } from "./request-routing.js";

export interface DirectChatTarget extends ProviderProxyUpstream { authorization: string }
export interface DirectChatCall {
  request: DirectChatRequest;
  clientHeaders?: IncomingHttpHeaders;
  target: DirectChatTarget;
  signal: AbortSignal;
  observer: DirectChatResponse;
  recheck(): void;
  submitted(): void;
  headers(status: number): void;
  content(): void;
  emit(value: Record<string, unknown>, terminal: boolean): Promise<void>;
}

/** One direct Chat exchange. No retries, redirects, caller identity, dump or metric submission. */
export async function sendDirectChat(call: DirectChatCall): Promise<void> {
  const payload = JSON.stringify(call.request);
  const forwarded = endToEndHeaders(call.clientHeaders ?? {});
  for (const name of Object.keys(forwarded)) {
    if (["authorization", "cookie", "host", "content-length", "content-type", "content-encoding", "accept", "accept-encoding", "expect",
      "forwarded", "x-real-ip", "x-api-key", "api-key", "x-provider"].includes(name)
      || name.startsWith("x-forwarded-") || name.startsWith("x-codex-") || name.startsWith("x-relay-")) delete forwarded[name];
  }
  const headers = { ...forwarded, authorization: call.target.authorization, "content-type": "application/json",
    "accept-encoding": "identity",
    accept: call.request.stream ? "text/event-stream" : "application/json", "content-length": String(Buffer.byteLength(payload)) };
  call.signal.throwIfAborted();
  call.recheck();
  // No asynchronous boundary is permitted between recheck and request creation.
  const request = (call.target.protocol === "http" ? httpRequest : httpsRequest)({
    hostname: call.target.host, port: call.target.port, agent: call.target.agent,
    path: `${call.target.basePath?.replace(/\/$/u, "") ?? ""}/chat/completions`, method: "POST", headers, signal: call.signal,
  });
  let timeoutError: ReturnType<typeof chatUpstreamError> | undefined;
  const timeout = (): void => { timeoutError = chatUpstreamError({ code: "upstream_timeout" }); request.destroy(timeoutError); };
  const timer = setTimeout(timeout, 60_000);
  request.setTimeout(60_000, timeout);
  try {
    const ready = once(request, "response");
    call.submitted(); request.end(payload);
    const [incoming] = await ready as [IncomingMessage];
    clearTimeout(timer);
    call.headers(incoming.statusCode ?? 502);
    if (incoming.statusCode !== 200) throw await readChatHttpError(incoming);
    const contentType = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (call.request.stream) {
      if (contentType !== "text/event-stream") throw new ChatUpstreamError("invalid_upstream_content_type", "Upstream response Content-Type does not match the requested JSON/SSE format.", false);
      for await (const data of readChatFrames(incoming, call.signal, {
        frameBytes: 1024 * 1024, bufferBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
      })) {
        if (data === "[DONE]") { await call.emit(call.observer.finish(true), true); return; }
        const value: unknown = parseChatJson(data);
        const error = chatStreamError(value);
        if (error) throw error;
        const output = call.observer.push(value, true);
        if (call.observer.hasContent) call.content();
        if (output) await call.emit(output, false);
      }
      throw new ModelConversionError("Chat stream disconnected before DONE");
    }
    if (contentType !== "application/json") throw new ChatUpstreamError("invalid_upstream_content_type", "Upstream response Content-Type does not match the requested JSON/SSE format.", false);
    const body = await readChatBody(incoming, call.signal, 8 * 1024 * 1024);
    const parsed: unknown = parseChatJson(body);
    const envelopeError = chatStreamError(parsed);
    if (envelopeError) throw envelopeError;
    const value = directChatJsonPayload(parsed);
    const error = chatStreamError(value);
    if (error) throw error;
    const output = directChatJson(value, call.observer);
    if (call.observer.hasContent) call.content();
    await call.emit(output, true);
  } catch (error) { throw timeoutError ?? error; }
  finally { clearTimeout(timer); request.destroy(); }
}

function parseChatJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new ChatUpstreamError("invalid_upstream_json", "Upstream response contains invalid JSON.", false); }
}

/** CLP's observed non-streaming envelope; unwrap once, never guess arbitrary wrappers. */
function directChatJsonPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !Object.hasOwn(value, "success") || !Object.hasOwn(value, "data")) return value;
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true) throw chatUpstreamError(undefined);
  if (Object.hasOwn(envelope, "choices")) {
    throw new ChatUpstreamError("invalid_upstream_envelope", "Upstream response contains both a Chat object and a wrapped Chat object.", false);
  }
  return envelope.data;
}
