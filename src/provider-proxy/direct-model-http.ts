import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";
import { sanitizeModelRequestUrl } from "../../runtime/model-request-address.mjs";
import { ChatUpstreamError, ModelRequestTimeoutError, readChatHttpError } from "./chat-errors.js";
import { ChatBodyEncodingError, readChatBody } from "./chat-io.js";
import type { DirectChatCapture } from "./relay-traffic-dump.js";
import type { ProviderProxyUpstream } from "./proxy.js";
import { effectiveUpstreamUserAgent } from "./response-metrics-observer.js";
import { endToEndHeaders } from "./request-routing.js";

export interface DirectModelTarget extends ProviderProxyUpstream { authorization: string }

export async function validateDirectModelResponse(incoming: IncomingMessage, stream: boolean, capture?: Pick<DirectChatCapture, "value" | "invalid">, signal?: AbortSignal, tools?: unknown): Promise<void> {
  if (incoming.statusCode !== 200) throw await readChatHttpError(incoming, capture, signal, tools);
  const encoding = incoming.headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
    throw new ChatUpstreamError("invalid_upstream_encoding", "Upstream response uses an unsupported Content-Encoding.", false);
  }
  const contentType = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== (stream ? "text/event-stream" : "application/json")) {
    throw new ChatUpstreamError("invalid_upstream_content_type", "Upstream response Content-Type does not match the requested JSON/SSE format.", false);
  }
}

export function parseDirectModelJson(text: string, capture?: DirectChatCapture): unknown {
  try { return JSON.parse(text) as unknown; }
  catch {
    capture?.invalid(Buffer.byteLength(text));
    throw new ChatUpstreamError("invalid_upstream_json", "Upstream response contains invalid JSON.", false);
  }
}

/** A successful non-streaming response must complete within its own body budget. */
export async function readDirectModelBody(incoming: IncomingMessage, signal: AbortSignal, maximumBytes = 8 * 1024 * 1024): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ModelRequestTimeoutError("body")), modelRequestPolicy.bodyReadTimeoutMs);
  try { return await readChatBody(incoming, AbortSignal.any([signal, controller.signal]), Math.min(maximumBytes, 8 * 1024 * 1024)); }
  catch (error) {
    if (error instanceof ChatBodyEncodingError) throw new ChatUpstreamError("invalid_upstream_encoding", "Upstream response contains invalid UTF-8.", false);
    throw error;
  }
  finally { clearTimeout(timer); }
}

interface DirectModelHttpCall {
  body: Record<string, unknown> & { stream: boolean };
  path: "/chat/completions" | "/responses";
  target: DirectModelTarget;
  clientHeaders?: IncomingHttpHeaders;
  signal: AbortSignal;
  recheck(): void;
  submitted(userAgent: string | null, headers: OutgoingHttpHeaders, path: string, requestBytes: number, upstreamUrl: string | null): void;
  transformed?(operation: "headers_filtered" | "headers_overridden"): void;
}

/** One bounded HTTP exchange; protocol parsing stays in the consuming adapter. */
export async function withDirectModelResponse(call: DirectModelHttpCall, consume: (incoming: IncomingMessage) => Promise<void>): Promise<void> {
  const payload = JSON.stringify(call.body);
  const payloadBytes = Buffer.byteLength(payload);
  const forwarded = endToEndHeaders(call.clientHeaders ?? {});
  const originalHeaderNames = Object.keys(call.clientHeaders ?? {});
  for (const name of Object.keys(forwarded)) {
    if (["authorization", "cookie", "host", "content-length", "content-type", "content-encoding", "accept", "accept-encoding", "expect",
      "forwarded", "x-real-ip", "x-api-key", "api-key", "x-provider"].includes(name)
      || name.startsWith("x-forwarded-") || name.startsWith("x-codex-") || name.startsWith("x-relay-")) delete forwarded[name];
  }
  const headers = { ...forwarded, authorization: call.target.authorization, "content-type": "application/json",
    "accept-encoding": "identity",
    accept: call.body.stream ? "text/event-stream" : "application/json", "content-length": String(payloadBytes) };
  if (originalHeaderNames.some(name => !Object.hasOwn(forwarded, name))) call.transformed?.("headers_filtered");
  call.transformed?.("headers_overridden");
  call.signal.throwIfAborted();
  call.recheck();
  // No asynchronous boundary is permitted between recheck and request creation.
  const request = (call.target.protocol === "http" ? httpRequest : httpsRequest)({
    hostname: call.target.host, port: call.target.port, agent: call.target.agent,
    path: `${call.target.basePath?.replace(/\/$/u, "") ?? ""}${call.path}`, method: "POST", headers, signal: call.signal,
  });
  let timeoutError: ModelRequestTimeoutError | undefined;
  const timeout = (): void => { timeoutError = new ModelRequestTimeoutError("headers"); request.destroy(timeoutError); };
  const timer = setTimeout(timeout, modelRequestPolicy.headersTimeoutMs);
  try {
    const ready = once(request, "response");
    const ua = request.getHeader("user-agent");
    const observedUa = effectiveUpstreamUserAgent({ "user-agent": typeof ua === "string" ? ua : undefined }, undefined);
    request.end(payload);
    call.submitted(observedUa !== null && [...observedUa].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? null : observedUa,
      request.getHeaders(), request.path, payloadBytes,
      sanitizeModelRequestUrl(/^https?:\/\//u.test(request.path) ? request.path : `${request.protocol}//${String(request.getHeader("host"))}${request.path}`));
    const [incoming] = await ready as [IncomingMessage];
    clearTimeout(timer);
    await consume(incoming);
  } catch (error) { throw timeoutError ?? error; }
  finally { clearTimeout(timer); request.destroy(); }
}
