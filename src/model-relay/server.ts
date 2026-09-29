import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { DirectChatRequestError, DirectChatResponseError, DirectChatResponse, ModelConversionError, validateDirectChatRequest } from "../model-api/index.js";
import { ChatBodyTooLargeError, ChatUpstreamError, readChatBody, sendDirectChat, waitForChatOperation, writeChatData, type DirectChatCapture, type DirectChatTarget, type RelayMetric } from "../provider-proxy/index.js";
import { RelayAdmission, RelayAdmissionError, type RelayLease, type RelayPolicy } from "./admission.js";

export interface PreparedRelayProvider {
  readonly target: DirectChatTarget;
  readonly models: readonly string[];
  /** Must synchronously check the current published material revision. */
  recheck(): void;
}
export type { RelayMetric } from "../provider-proxy/index.js";
export interface ModelRelayOptions {
  policy: RelayPolicy;
  capture?(provider: string): DirectChatCapture | undefined;
  prepare(provider: string, signal: AbortSignal): Promise<PreparedRelayProvider>;
  enqueueMetric(metric: RelayMetric): void;
}

/** Independent HTTP lifecycle; injected preparation never runs before authentication. */
export class ModelRelayServer {
  readonly admission: RelayAdmission;
  private readonly active = new Set<AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly headerTimers = new Map<Socket, NodeJS.Timeout>();
  private readonly server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 15_000 },
    (request, response) => {
      clearTimeout(this.headerTimers.get(request.socket)); this.headerTimers.delete(request.socket);
      const task = this.handle(request, response);
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    });
  private closing: Promise<void> | undefined;
  private stopping = false;
  private metricFailures = 0;

  constructor(private readonly options: ModelRelayOptions) {
    this.admission = new RelayAdmission(options.policy);
    this.server.maxConnections = 64;
    this.server.maxRequestsPerSocket = 1;
    this.server.on("connection", socket => {
      this.headerTimers.set(socket, setTimeout(() => socket.destroy(), 10_000));
      socket.once("close", () => { clearTimeout(this.headerTimers.get(socket)); this.headerTimers.delete(socket); });
    });
  }
  async start(port: number, host = "127.0.0.1"): Promise<void> {
    if (host !== "127.0.0.1" && host !== "::1") throw new Error("Relay requires a loopback address");
    if (this.stopping) throw new Error("Relay is closed");
    const ready = once(this.server, "listening"); this.server.listen(port, host); await ready;
  }
  address(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Relay is not listening");
    return `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  }
  diagnostics(): { active: number; metricFailures: number; queue: { pending: number; waiting: number; bytes: number } } {
    return { active: this.admission.active, queue: this.admission.queue, metricFailures: this.metricFailures };
  }
  /** Disable the endpoint without forgetting the process's rate history. */
  async stopListening(): Promise<void> {
    this.admission.failClosed();
    for (const controller of this.active) controller.abort();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.allSettled(this.tasks);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.admission.stopWaiting();
    this.closing = (async () => {
      const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
      const timer = setTimeout(() => {
        this.admission.close(); for (const controller of this.active) controller.abort(); this.server.closeAllConnections();
      }, 5000);
      try { await closed; } finally {
        clearTimeout(timer); this.admission.close();
        for (const controller of this.active) controller.abort();
        await Promise.allSettled(this.tasks);
      }
    })();
    return this.closing;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.socket.setTimeout(0);
    response.setHeader("connection", "close");
    const controller = new AbortController(); this.active.add(controller);
    const totalTimer = setTimeout(() => controller.abort(new RelayAdmissionError(504, "request_timeout")), 300_000);
    const disconnected = (): void => { if (!response.writableFinished) controller.abort(new RelayAdmissionError(499, "client_disconnected")); };
    response.once("close", disconnected);
    let lease: RelayLease | undefined;
    let capture: DirectChatCapture | undefined;
    let started: number | undefined;
    let submittedAt: number | undefined;
    let completedAt: number | undefined;
    let firstTokenMs: number | undefined;
    let httpStatus: number | undefined;
    let userAgent: string | null = null;
    let errorCode: string | undefined;
    let requestModel = "";
    let stream = false;
    let phase: "input" | "queue" | "prepare" | "upstream" | "delivery" = "input";
    const observer = new DirectChatResponse();
    const relayRequestId = randomUUID();
    response.setHeader("x-relay-request-id", relayRequestId);
    let deliveryStatus: RelayMetric["deliveryStatus"] = "failed";
    try {
      if (this.stopping) throw new RelayAdmissionError(503, "relay_unavailable");
      if (request.url !== "/v1/chat/completions" && request.url !== "/v1/models") throw new RelayAdmissionError(404, "not_found");
      const models = request.url === "/v1/models";
      if (request.method !== (models ? "GET" : "POST")) throw new RelayAdmissionError(405, "method_not_allowed");
      if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === "authorization").length !== 1) {
        // Invalid header shapes share the bounded authentication-failure bucket.
        this.admission.acquire(undefined);
      }
      lease = models ? this.admission.acquire(request.headers.authorization) : this.admission.reserve(request.headers.authorization);
      const signal = AbortSignal.any([controller.signal, lease.signal]);
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new RelayAdmissionError(415, "unsupported_encoding");
      let body: ReturnType<typeof validateDirectChatRequest> | undefined;
      if (!models) {
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new RelayAdmissionError(415, "unsupported_media_type");
        if (Number(request.headers["content-length"] ?? 0) > 1024 * 1024) throw new RelayAdmissionError(413, "request_too_large");
        const uploadTimer = setTimeout(() => controller.abort(new RelayAdmissionError(408, "upload_timeout")), 15_000);
        try {
          const text = await readChatBody(request, signal, 1024 * 1024);
          body = validateDirectChatRequest(JSON.parse(text) as unknown);
        } finally { clearTimeout(uploadTimer); }
        lease.check(body.model); requestModel = body.model; stream = body.stream;
      } else if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) {
        throw new RelayAdmissionError(400, "invalid_request");
      }
      if (body) {
        phase = "queue";
        await this.admission.wait(lease, body.model, Buffer.byteLength(JSON.stringify(body)), signal);
        signal.throwIfAborted();
      }
      phase = "prepare";
      const prepared = await waitForChatOperation(this.options.prepare(lease.caller.provider, signal), signal);
      lease.check(body?.model); prepared.recheck();
      if (models) {
        await endResponse(response, JSON.stringify({ object: "list", data: prepared.models.filter(model => lease!.caller.models.includes(model))
          .map(id => ({ id, object: "model", owned_by: "relay" })) }), signal);
        return;
      }
      if (!prepared.models.includes(body!.model)) throw new RelayAdmissionError(403, "model_not_allowed");
      phase = "upstream";
      capture = this.options.capture?.(lease.caller.provider);
      await sendDirectChat({ ...(capture ? { capture } : {}), request: body!, clientHeaders: request.headers, target: prepared.target, signal, observer,
        recheck: () => { lease!.check(body!.model); prepared.recheck(); },
        submitted: ua => { userAgent = ua; started = performance.now(); submittedAt = Date.now(); },
        headers: status => { httpStatus = status; },
        content: () => { firstTokenMs ??= performance.now() - started!; },
        emit: async (value, terminal) => {
          if (terminal) { completedAt = performance.now(); phase = "delivery"; }
          if (stream) {
            const frame = `data: ${JSON.stringify(value)}\n\n`;
            if (Buffer.byteLength(frame) > 1024 * 1024) throw new ModelConversionError("Chat delivery frame exceeds size limit");
            if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
            await writeChatData(response, frame, signal);
            if (terminal) await endResponse(response, "data: [DONE]\n\n", signal);
          } else await endResponse(response, JSON.stringify(value), signal);
        },
      });
      deliveryStatus = "finished";
    } catch (error) {
      const signalReason: unknown = controller.signal.reason ?? lease?.signal.reason;
      const failure = signalReason instanceof RelayAdmissionError ? signalReason : error;
      const status = failure instanceof RelayAdmissionError ? failure.status
        : phase === "input" && failure instanceof ChatBodyTooLargeError ? 413
        : failure instanceof ChatUpstreamError && failure.code === "rate_limit" ? 429
          : failure instanceof ChatUpstreamError && failure.code === "upstream_timeout" ? 504
            : phase === "input" ? 400 : phase === "prepare" ? 503 : 502;
      errorCode = failure instanceof RelayAdmissionError || failure instanceof ChatUpstreamError || failure instanceof DirectChatResponseError ? failure.code
        : phase === "input" && failure instanceof ChatBodyTooLargeError ? "request_too_large"
        : error instanceof ModelConversionError ? phase === "input" ? "invalid_request" : "invalid_upstream_response"
          : phase === "input" ? "invalid_request" : "upstream_error";
      deliveryStatus = response.destroyed || status === 499 ? "disconnected" : "failed";
      if (!response.destroyed) {
        const message = phase === "input" && failure instanceof DirectChatRequestError
          || failure instanceof ChatUpstreamError || failure instanceof DirectChatResponseError
          ? failure.message : errorCode === "model_not_allowed"
            ? "Requested model is not allowed by this Relay key or is unavailable in its provider catalog. Use an exact model ID returned by GET /v1/models."
            : errorCode === "relay_queue_full" ? "Relay waiting queue is full. Retry later."
              : errorCode === "relay_queue_timeout" ? "Relay request waited more than 30 seconds for an execution slot."
                : "Model request could not be completed.";
        const detail = { error: { type: "relay_error", code: errorCode,
          message: failure instanceof DirectChatRequestError && phase === "input" ? message
            : `${message} [${errorCode}; phase=${phase}${httpStatus === undefined ? "" : `; upstream_http=${httpStatus}`}; request_id=${relayRequestId}]`,
          ...(phase === "input" && failure instanceof DirectChatRequestError ? { param: failure.param } : {}),
          phase, request_id: relayRequestId, ...(httpStatus === undefined ? {} : { upstream_status: httpStatus }),
          upstream_attempted: started !== undefined } };
        if (!request.complete) response.once("finish", () => request.destroy());
        // Error delivery has a separate short bound, even if the model request was cancelled.
        try {
          if (response.headersSent) await endResponse(response, `data: ${JSON.stringify(detail)}\n\n`, AbortSignal.timeout(1000));
          else { response.statusCode = status === 499 ? 502 : status; await endResponse(response, JSON.stringify(detail), AbortSignal.timeout(1000)); }
        } catch { response.destroy(); }
      }
    } finally {
      clearTimeout(totalTimer); response.off("close", disconnected); controller.abort(); this.active.delete(controller);
      const traffic = capture?.finish(deliveryStatus, errorCode, firstTokenMs);
      if (lease && started !== undefined) {
        const ended = completedAt ?? performance.now();
        const metric: RelayMetric = { source: "relay", threadId: null, turnId: null, relayRequestId,
          ...(traffic ? { traffic } : {}),
          callerId: lease.caller.callerId, keyId: lease.caller.keyId, credentialGeneration: lease.caller.credentialGeneration,
          provider: lease.caller.provider, requestModel, ...(userAgent === null ? {} : { userAgent }), responseFormat: stream ? "sse" : "json",
          status: observer.status === "unknown" ? "failed" : observer.status, deliveryStatus,
          requestStartedAtMs: submittedAt!, responseCompletedAtMs: submittedAt! + (ended - started), totalDurationMs: ended - started,
          ...observer.usage, ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
          ...(observer.responseModel === undefined ? {} : { responseModel: observer.responseModel }),
          ...(httpStatus === undefined ? {} : { httpStatus }), ...(errorCode === undefined ? {} : { errorCode }) };
        try { this.options.enqueueMetric(metric); } catch { this.metricFailures = Math.min(Number.MAX_SAFE_INTEGER, this.metricFailures + 1); }
      }
      lease?.release();
    }
  }
}

async function endResponse(response: ServerResponse, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!response.headersSent) response.setHeader("content-type", "application/json");
  const done = once(response, "finish", { signal }); response.end(text); await done;
}
