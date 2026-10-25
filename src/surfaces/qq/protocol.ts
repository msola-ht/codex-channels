import { assertChannelFileName, maximumChannelFileBytes } from "../bounded-local-file.js";
import type { QqRecipient } from "./addressing.js";

const API_ORIGIN = "https://api.bot.qq.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type QqProtocolOperation = "token" | "gateway" | "message" | "menu" | "interaction";
export type QqProtocolFailure =
  | "invalid-input" | "closed" | "cancelled" | "timeout" | "network"
  | "http" | "business" | "invalid-response" | "response-too-large"
  | "authorization" | "expired" | "budget";

/** Local policy, not a discovered QQ platform maximum. One already planned part. */
export const QQ_TEXT_PART_BYTES = 2000;
/** Active Markdown plus keyboard: 6000-byte sample confirmed on platform and client. */
export const QQ_MENU_PART_BYTES = 6000;
/** Local layout budget aligned with Feishu cards; not a QQ platform limit. */
export const QQ_BODY_MARKDOWN_PART_CHARACTERS = 5_000;
/** A Unicode scalar occupies at most four UTF-8 bytes. */
export const QQ_BODY_MARKDOWN_PART_BYTES = QQ_BODY_MARKDOWN_PART_CHARACTERS * 4;
export const QQ_PASSIVE_WINDOW_MS = 300_000;

export type QqTextMessage = {
  recipient: QqRecipient;
  content: string;
} & ({ mode: "active" } | {
  mode: "passive";
  messageId: string;
  sequence: number;
  sourceTimestampMs: number;
});

export type QqInteractionAckCode = 0 | 1 | 2 | 3 | 4;

/** Callback execution and input-prefill commands have separate action contracts. */
export interface QqCommandKeyboard {
  content: { rows: Array<{ buttons: Array<{
    id: string;
    render_data: { label: string; style: 0 | 1; visited_label?: string };
    action:
      | { type: 2; permission: { type: 2 }; data: string; enter: boolean; reply: false }
      | { type: 0; permission: { type: 2 }; data: string }
      | { type: 1; permission: { type: 2 }; data: string; unsupport_tips: string };
  }> }> };
}

export interface QqTextSendContext {
  signal: AbortSignal;
  /** Synchronous current actor/source/recipient check, before token wait and final HTTP dispatch. */
  beforeSend: () => undefined;
}

/** One passive replace stream; sequence and source stay fixed across frames. */
export interface QqStreamFrame {
  recipient: string;
  messageId: string;
  sourceTimestampMs: number;
  content: string;
  index: number;
  streamId?: string;
  finished: boolean;
  contentType: "text" | "markdown";
}
export const QQ_STREAM_BYTES = 16_000;
/** Local complete-result file budget, below QQ's documented direct-upload limit. */
export const QQ_RESULT_FILE_BYTES = 256 * 1024;
/** Conservative local binary-upload budget; QQ documents direct uploads within 5M. */
export const QQ_IMAGE_BYTES = 5_000_000;

export interface QqImageMessage {
  readonly recipient: QqRecipient;
  /** Already validated PNG/JPEG bytes from the shared image reader. No paths or URLs. */
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg";
}

export type QqTextRejection = "permission" | "refused" | "expired" | "reply-window-or-limit"
  | "rate-limit" | "duplicate" | "length" | "format" | "content" | "unavailable";
export type QqTextOutcome = "not-sent" | "rejected" | "unknown";

/** Contains local classifications only; upstream text and credentials never escape. */
export class QqProtocolError extends Error {
  constructor(
    readonly operation: QqProtocolOperation,
    readonly reason: QqProtocolFailure,
    readonly httpStatus?: number,
    readonly bizCode?: number,
    readonly traceId?: string,
  ) {
    super(`QQ ${operation}: ${reason}`);
    this.name = "QqProtocolError";
  }
}

export class QqTextSendError extends QqProtocolError {
  constructor(
    readonly outcome: QqTextOutcome,
    error: QqProtocolError,
    readonly rejection?: QqTextRejection,
  ) {
    super("message", error.reason, error.httpStatus, error.bizCode, error.traceId);
    this.name = "QqTextSendError";
  }
}

export interface QqProtocolClientOptions {
  appId: string;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/** One immutable account/credential generation. Replace the client on configuration changes. */
export class QqProtocolClient {
  private readonly lifetime = new AbortController();
  private cachedToken: { value: string; expiresAt: number } | undefined;
  private tokenFlight: Promise<string> | undefined;
  private generation = 0;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QqProtocolClientOptions) {
    if (!/^[0-9]+$/u.test(options.appId)
      || options.appSecret.length === 0 || /\s/u.test(options.appSecret)
      || [...options.appSecret].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      })) {
      throw new QqProtocolError("token", "invalid-input");
    }
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.fetchImpl = options.fetchImpl;
  }

  close(): void {
    this.generation++;
    this.cachedToken = undefined;
    this.lifetime.abort();
  }

  invalidateAccessToken(): void {
    this.generation++;
    this.cachedToken = undefined;
  }

  async getAccessToken(signal?: AbortSignal, minimumRemainingMs = 60_000): Promise<string> {
    this.ensureOpen("token", signal);
    const cached = this.cachedToken;
    if (cached && cached.expiresAt - Date.now() > minimumRemainingMs) return cached.value;
    if (!this.tokenFlight) {
      const generation = this.generation;
      const startedAt = Date.now();
      const flight = this.requestJson("token", "/app/getAppAccessToken", {
        appId: this.appId,
        clientSecret: this.appSecret,
      }).then((data) => {
        const expiresIn = typeof data.expires_in === "string"
          && /^[1-9][0-9]{0,3}$/.test(data.expires_in)
          ? Number(data.expires_in) : data.expires_in;
        if (typeof data.access_token !== "string"
          || !/^[\x21-\x7e]{1,4096}$/.test(data.access_token)
          || typeof expiresIn !== "number" || !Number.isInteger(expiresIn)
          || expiresIn <= 0 || expiresIn > 7200) {
          throw new QqProtocolError("token", "invalid-response");
        }
        this.ensureOpen("token");
        if (generation !== this.generation) {
          throw new QqProtocolError("token", "cancelled");
        }
        this.cachedToken = { value: data.access_token, expiresAt: startedAt + expiresIn * 1000 };
        return data.access_token;
      });
      this.tokenFlight = flight;
      void flight.finally(() => {
        if (this.tokenFlight === flight) this.tokenFlight = undefined;
      }).catch(() => undefined);
    }
    // A cancelled caller leaves the bounded, account-owned refresh available to other callers.
    const token = await abortable(this.tokenFlight, signal, "token");
    this.ensureOpen("token", signal);
    if (this.cachedToken?.value !== token || this.cachedToken.expiresAt - Date.now() <= minimumRemainingMs) {
      throw new QqProtocolError("token", "timeout");
    }
    return token;
  }

  async getGatewayUrl(signal?: AbortSignal): Promise<string> {
    return await this.withRequest("gateway", signal, async (requestSignal) => {
      const token = await this.getAccessToken(requestSignal);
      const data = await this.requestJson("gateway", "/gateway", undefined, requestSignal, token);
      if (typeof data.url !== "string" || data.url.length > 2048) {
        throw new QqProtocolError("gateway", "invalid-response");
      }
      let url: URL;
      try { url = new URL(data.url); } catch {
        throw new QqProtocolError("gateway", "invalid-response");
      }
      // Discovery is authenticated against the fixed official API; no caller-supplied endpoint.
      if (url.protocol !== "wss:" || url.username || url.password || url.hash
        || (url.port && url.port !== "443")) {
        throw new QqProtocolError("gateway", "invalid-response");
      }
      return url.href;
    });
  }

  /** Application-wide menu management; never called by Gateway startup or message delivery. */
  async getBotMenu(context: QqTextSendContext): Promise<{ version: number | undefined; menu: unknown }> {
    return await this.withRequest("menu", context.signal, async signal => {
      context.beforeSend();
      const token = await this.getAccessToken(signal);
      const data = await this.requestJson("menu", "/v2/menu", undefined, signal, token, context.beforeSend);
      // Observed unconfigured response is { menu: {} }, without a version. Preserve absence;
      // never invent revision zero or accept an existing unversioned menu for replacement.
      if (!Object.hasOwn(data, "version") && record(data.menu) && Object.keys(data.menu).length === 0) {
        return { version: undefined, menu: {} };
      }
      if (typeof data.version !== "number" || !Number.isSafeInteger(data.version) || data.version < 0) {
        throw new QqProtocolError("menu", "invalid-response");
      }
      return { version: data.version, menu: data.menu };
    });
  }

  /** Full replacement, no automatic retries. The management owner validates and confirms the snapshot. */
  async putBotMenu(menu: Record<string, unknown>, context: QqTextSendContext): Promise<{ version: number }> {
    if (!record(menu)) throw new QqProtocolError("menu", "invalid-input");
    // Freeze the exact confirmed payload before any asynchronous credential wait.
    let body: Record<string, unknown>;
    try {
      const serialized = JSON.stringify({ menu });
      if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) throw new Error();
      body = JSON.parse(serialized) as Record<string, unknown>;
    } catch { throw new QqProtocolError("menu", "invalid-input"); }
    return await this.withRequest("menu", context.signal, async signal => {
      context.beforeSend();
      const token = await this.getAccessToken(signal);
      const data = await this.requestJson("menu", "/v2/menu", body, signal, token, context.beforeSend, "PUT");
      if (typeof data.version !== "number" || !Number.isSafeInteger(data.version) || data.version < 0) {
        throw new QqProtocolError("menu", "invalid-response");
      }
      return { version: data.version };
    });
  }

  /** A single receipt acknowledgment, independent of whether the selected business action completes. */
  async acknowledgeInteraction(id: string, code: QqInteractionAckCode, context: QqTextSendContext): Promise<void> {
    if (!identifier(id) || id.startsWith("INTERACTION_CREATE:")
      || !Number.isInteger(code) || code < 0 || code > 4
      || !context || !(context.signal instanceof AbortSignal) || typeof context.beforeSend !== "function") {
      throw new QqProtocolError("interaction", "invalid-input");
    }
    const { signal: callerSignal, beforeSend } = context;
    try {
      await this.withRequest("interaction", callerSignal, async signal => {
        const check = () => {
          this.ensureOpen("interaction", signal);
          try {
            const result: unknown = beforeSend();
            if (result !== undefined) {
              void Promise.resolve(result).catch(() => undefined);
              throw new Error();
            }
          } catch { throw new QqProtocolError("interaction", "authorization"); }
          this.ensureOpen("interaction", signal);
        };
        check();
        const token = await this.getAccessToken(signal);
        const data = await this.requestJson("interaction", `/interactions/${encodeURIComponent(id)}`, { code }, signal, token, check, "PUT");
        // The official success example is {}; explicit zero result codes are also conclusive.
        // Do not infer acknowledgment from arbitrary successful HTTP JSON.
        const keys = Object.keys(data);
        if (keys.some(key => !["code", "err_code", "trace_id"].includes(key))
          || (keys.length > 0 && !("code" in data) && !("err_code" in data))) {
          throw new QqProtocolError("interaction", "invalid-response");
        }
      });
    } catch (error) {
      if (error instanceof QqProtocolError && error.operation !== "interaction") {
        throw new QqProtocolError("interaction", error.reason, error.httpStatus, error.bizCode, error.traceId);
      }
      throw error;
    }
  }

  /** No retries, mode fallback, splitting, task submission or delivery checkpoint side effects. */
  async sendText(input: QqTextMessage, context: QqTextSendContext): Promise<{ messageId: string }> {
    return this.sendPlan(() => textRequest(input), context);
  }

  /** A single complete Markdown body or trusted menu, with the text recipient/deadline/receipt contract. */
  async sendMarkdown(input: QqTextMessage, context: QqTextSendContext & { body?: true }, keyboard?: QqCommandKeyboard): Promise<{ messageId: string }> {
    return this.sendPlan(() => {
      if (context.body && (input.mode !== "active" || keyboard)) throw new QqProtocolError("message", "invalid-input");
      const plan = textRequest(input, context.body ? QQ_BODY_MARKDOWN_PART_BYTES
        : keyboard && input.mode === "active" ? QQ_MENU_PART_BYTES : QQ_TEXT_PART_BYTES);
      if (context.body && Array.from(input.content).length > QQ_BODY_MARKDOWN_PART_CHARACTERS) {
        throw new QqProtocolError("message", "invalid-input");
      }
      const { content, ...body } = plan.body;
      return { ...plan, body: { ...body, msg_type: 2, markdown: { content },
        ...(keyboard === undefined ? {} : { keyboard: commandKeyboard(keyboard) }) } };
    }, context);
  }

  async sendStream(input: QqStreamFrame, context: QqTextSendContext): Promise<{ messageId: string }> {
    return this.sendPlan(() => {
      if (!record(input) || !identifier(input.recipient) || !identifier(input.messageId)
        || typeof input.content !== "string" || !input.content.trim() || !wellFormed(input.content)
        || input.content.length > QQ_STREAM_BYTES || Buffer.byteLength(input.content) > QQ_STREAM_BYTES
        || !Number.isSafeInteger(input.index) || input.index < 0 || input.index > 120
        || typeof input.finished !== "boolean"
        || (input.contentType !== "text" && input.contentType !== "markdown")
        || (input.index === 0 ? input.streamId !== undefined : !identifier(input.streamId))
        || Object.keys(input).some(key => !["recipient", "messageId", "sourceTimestampMs", "content", "index", "streamId", "finished", "contentType"].includes(key))) {
        throw new QqProtocolError("message", "invalid-input");
      }
      const age = Date.now() - input.sourceTimestampMs;
      if (!Number.isSafeInteger(input.sourceTimestampMs) || input.sourceTimestampMs < 0 || age < 0) {
        throw new QqProtocolError("message", "invalid-input");
      }
      if (age >= QQ_PASSIVE_WINDOW_MS) throw new QqProtocolError("message", "expired");
      return { path: `/v2/users/${encodeURIComponent(input.recipient)}/stream_messages`,
        body: { input_mode: "replace", content_type: input.contentType, content_raw: input.content,
          input_state: input.finished ? 10 : 1, index: input.index, msg_id: input.messageId, msg_seq: 2,
          ...(input.streamId ? { stream_msg_id: input.streamId } : {}) },
        deadline: performance.now() + QQ_PASSIVE_WINDOW_MS - age };
    }, context);
  }

  async sendResultFile(input: { recipient: QqRecipient; content: string }, context: QqTextSendContext): Promise<{ messageId: string }> {
    return this.sendPlan(() => {
      if (!record(input) || !recipient(input.recipient) || typeof input.content !== "string"
        || !input.content.trim() || !wellFormed(input.content) || input.content.length > QQ_RESULT_FILE_BYTES
        || Buffer.byteLength(input.content) > QQ_RESULT_FILE_BYTES
        || Object.keys(input).some(key => key !== "recipient" && key !== "content")) {
        throw new QqProtocolError("message", "invalid-input");
      }
      return { path: recipientPath(input.recipient, "files"), body: {
        file_type: 4, srv_send_msg: true, file_name: "codex-result.txt",
        file_data: Buffer.from(input.content, "utf8").toString("base64"),
      } };
    }, context);
  }

  /** One active image delivery. srv_send_msg=true must return a valid message ID. */
  async sendImage(input: QqImageMessage, context: QqTextSendContext): Promise<{ messageId: string }> {
    return this.sendPlan(() => {
      if (!record(input) || !recipient(input.recipient) || !(input.bytes instanceof Uint8Array)
        || input.bytes.byteLength === 0 || input.bytes.byteLength > QQ_IMAGE_BYTES
        || (input.contentType !== "image/png" && input.contentType !== "image/jpeg")
        || Object.keys(input).some(key => !["recipient", "bytes", "contentType"].includes(key))) {
        throw new QqProtocolError("message", "invalid-input");
      }
      // Copy into immutable Base64 before credential or authorization waits, just
      // like result-file uploads. The endpoint explicitly supports PNG/JPEG.
      return { path: recipientPath(input.recipient, "files"), body: {
        file_type: 1, srv_send_msg: true,
        file_name: input.contentType === "image/png" ? "codex-image.png" : "codex-image.jpg",
        file_data: Buffer.from(input.bytes).toString("base64"),
      } };
    }, context);
  }

  /** Explicit local-file delivery; independent from the bounded complete-text fallback. */
  async sendFile(input: { recipient: QqRecipient; bytes: Uint8Array; fileName: string }, context: QqTextSendContext): Promise<{ messageId: string }> {
    return this.sendPlan(() => {
      if (!record(input) || !recipient(input.recipient) || !(input.bytes instanceof Uint8Array)
        || input.bytes.byteLength === 0 || input.bytes.byteLength > maximumChannelFileBytes
        || Object.keys(input).some(key => !["recipient", "bytes", "fileName"].includes(key))) {
        throw new QqProtocolError("message", "invalid-input");
      }
      assertChannelFileName(input.fileName);
      return { path: recipientPath(input.recipient, "files"), body: {
        file_type: 4, srv_send_msg: true, file_name: input.fileName,
        file_data: Buffer.from(input.bytes).toString("base64"),
      } };
    }, context);
  }

  private async sendPlan(makePlan: () => { path: string; body: Record<string, unknown>; deadline?: number }, context: QqTextSendContext): Promise<{ messageId: string }> {
    let attempted = false;
    try {
      const plan = makePlan();
      if (!context || !(context.signal instanceof AbortSignal) || typeof context.beforeSend !== "function") {
        throw new QqProtocolError("message", "invalid-input");
      }
      const { signal, beforeSend } = context;
      return await this.withRequest("message", signal, async (requestSignal) => {
        const deadline = performance.now() + REQUEST_TIMEOUT_MS;
        const checkTime = () => {
          if (performance.now() >= deadline) throw new QqProtocolError("message", "timeout");
          if (plan.deadline !== undefined && performance.now() >= plan.deadline) {
            throw new QqProtocolError("message", "expired");
          }
        };
        const check = () => {
          this.ensureOpen("message", requestSignal);
          checkTime();
          try {
            const result: unknown = beforeSend();
            if (result !== undefined) {
              // JS callers can still pass async guards. Never send while their result is pending.
              void Promise.resolve(result).catch(() => undefined);
              throw new Error();
            }
          }
          catch { throw new QqProtocolError("message", "authorization"); }
          this.ensureOpen("message", requestSignal);
          checkTime();
        };
        check();
        const token = await this.getAccessToken(requestSignal);
        const data = await this.requestJson("message", plan.path, plan.body, requestSignal, token, () => {
          check();
          // From here onward even a synchronous transport failure is conservatively unknown.
          attempted = true;
        });
        return { messageId: data.id as string }; // readTextResponse validates the ID before returning.
      });
    } catch (error) {
      const failure = error instanceof QqProtocolError ? error : new QqProtocolError("message", "invalid-input");
      const rejection = failure.reason === "business" && failure.bizCode !== undefined
        ? textRejection(failure.bizCode) : undefined;
      throw new QqTextSendError(!attempted ? "not-sent" : rejection ? "rejected" : "unknown", failure,
        attempted ? rejection : undefined);
    }
  }

  private ensureOpen(operation: QqProtocolOperation, signal?: AbortSignal): void {
    if (this.lifetime.signal.aborted) throw new QqProtocolError(operation, "closed");
    if (signal?.aborted) throw new QqProtocolError(operation, "cancelled");
  }

  private async withRequest<T>(
    operation: QqProtocolOperation,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.ensureOpen(operation, signal);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();
    const combined = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    try {
      return await abortable(work(combined), combined, operation);
    } catch (error) {
      if (this.lifetime.signal.aborted) throw new QqProtocolError(operation, "closed");
      if (signal?.aborted) throw new QqProtocolError(operation, "cancelled");
      if (deadline.signal.aborted) throw new QqProtocolError(operation, "timeout");
      if (error instanceof QqProtocolError) throw error;
      throw new QqProtocolError(operation, "network");
    } finally {
      clearTimeout(timeout);
      deadline.abort();
    }
  }

  private async requestJson(
    operation: QqProtocolOperation,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    token?: string,
    beforeSend?: () => void,
    method?: "PUT",
  ): Promise<Record<string, unknown>> {
    return await this.withRequest(operation, signal, async (requestSignal) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `QQBot ${token}`;
      requestSignal.throwIfAborted();
      beforeSend?.();
      const response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        method: method ?? (body ? "POST" : "GET"),
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: requestSignal,
        redirect: "error",
      });
      if (operation === "message") return await readTextResponse(response, requestSignal);
      const traceId = safeTraceId(response.headers.get("x-tps-trace-id"));
      if (response.status !== 200 || response.redirected) {
        let code: number | undefined;
        let responseTrace: string | undefined;
        if (!response.redirected && response.body) {
          try {
            const failure: unknown = JSON.parse(await readBody(response, requestSignal, operation));
            if (record(failure)) {
              const candidate = failure.code ?? failure.err_code;
              if (typeof candidate === "number" && Number.isSafeInteger(candidate)) code = candidate;
              responseTrace = safeTraceId(failure.trace_id);
            }
          } catch { /* Malformed error bodies never replace the known HTTP failure. */ }
        } else void response.body?.cancel().catch(() => undefined);
        throw new QqProtocolError(operation, "http", response.status, code, traceId ?? responseTrace);
      }
      const raw = await readBody(response, requestSignal, operation);
      let data: unknown;
      try { data = JSON.parse(raw); } catch {
        throw new QqProtocolError(operation, "invalid-response", response.status, undefined, traceId);
      }
      if (!record(data)) throw new QqProtocolError(operation, "invalid-response", response.status);
      for (const key of ["code", "err_code"]) {
        if (!(key in data)) continue;
        const code = data[key];
        if (typeof code !== "number" || !Number.isSafeInteger(code)) {
          throw new QqProtocolError(operation, "invalid-response", response.status, undefined, traceId);
        }
        if (code !== 0) {
          throw new QqProtocolError(operation, "business", response.status, code,
            traceId ?? safeTraceId(data.trace_id));
        }
      }
      requestSignal.throwIfAborted();
      return data;
    });
  }
}

function textRequest(input: QqTextMessage, maximumBytes = QQ_TEXT_PART_BYTES): { path: string; body: Record<string, unknown>; deadline?: number } {
  if (!record(input) || !recipient(input.recipient) || typeof input.content !== "string"
    || !input.content.trim() || input.content.length > maximumBytes
    || !wellFormed(input.content) || Buffer.byteLength(input.content) > maximumBytes) {
    throw new QqProtocolError("message", "invalid-input");
  }
  const base = ["mode", "recipient", "content"];
  const passive = ["messageId", "sequence", "sourceTimestampMs"];
  const keys = input.mode === "passive" ? [...base, ...passive] : base;
  if (Object.keys(input).some(key => !keys.includes(key)) || !["active", "passive"].includes(input.mode)) {
    throw new QqProtocolError("message", "invalid-input");
  }
  const path = recipientPath(input.recipient, "messages");
  const body: Record<string, unknown> = { msg_type: 0, content: input.content };
  if (input.mode === "active") return { path, body };
  const age = Date.now() - input.sourceTimestampMs;
  if (!identifier(input.messageId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > 4
    || !Number.isSafeInteger(input.sourceTimestampMs) || input.sourceTimestampMs < 0 || age < 0) {
    throw new QqProtocolError("message", "invalid-input");
  }
  if (age >= QQ_PASSIVE_WINDOW_MS) throw new QqProtocolError("message", "expired");
  return { path, body: { ...body, msg_id: input.messageId, msg_seq: input.sequence },
    deadline: performance.now() + QQ_PASSIVE_WINDOW_MS - age };
}

function commandKeyboard(value: unknown): QqCommandKeyboard {
  const fail = (): never => { throw new QqProtocolError("message", "invalid-input"); };
  const exact = (item: unknown, keys: string[]): item is Record<string, unknown> =>
    record(item) && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
  if (!exact(value, ["content"]) || !exact(value.content, ["rows"]) || !Array.isArray(value.content.rows)
    || value.content.rows.length < 1 || value.content.rows.length > 5) return fail();
  const ids = new Set<string>();
  const rows = value.content.rows.map((row: unknown) => {
    if (!exact(row, ["buttons"]) || !Array.isArray(row.buttons) || row.buttons.length < 1 || row.buttons.length > 5) return fail();
    return { buttons: row.buttons.map((button: unknown): QqCommandKeyboard["content"]["rows"][number]["buttons"][number] => {
      if (!exact(button, ["id", "render_data", "action"]) || typeof button.id !== "string"
        || !/^[a-z0-9_-]{1,32}$/u.test(button.id) || ids.has(button.id)
        || !exact(button.render_data, record(button.action) && button.action.type === 0 ? ["label", "style", "visited_label"] : ["label", "style"]) || typeof button.render_data.label !== "string"
        || !button.render_data.label.trim() || [...button.render_data.label].length > 10
        || !wellFormed(button.render_data.label) || /\p{Cc}/u.test(button.render_data.label)
        || (button.render_data.style !== 0 && button.render_data.style !== 1)
        || !record(button.action) || !exact(button.action.permission, ["type"]) || button.action.permission.type !== 2
        || typeof button.action.data !== "string" || !button.action.data.trim() || [...button.action.data].length > (button.action.type === 0 ? 4096 : 100)
        || !wellFormed(button.action.data) || /\p{Cc}/u.test(button.action.data)) return fail();
      ids.add(button.id);
      if (button.action.type === 0) {
        if (!exact(button.action, ["type", "permission", "data"]) || typeof button.render_data.visited_label !== "string"
          || !button.render_data.visited_label.trim() || [...button.render_data.visited_label].length > 10
          || !wellFormed(button.render_data.visited_label) || /[\p{Cc}\p{Cf}]/u.test(button.render_data.visited_label)
          || /[\p{Cc}\p{Cf}]/u.test(button.action.data)) return fail();
        let url: URL;
        try { url = new URL(button.action.data); } catch { return fail(); }
        if (url.username || url.password || (url.protocol !== "https:"
          && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return fail();
        return { id: button.id, render_data: { label: button.render_data.label, style: button.render_data.style, visited_label: button.render_data.visited_label },
          action: { type: 0, permission: { type: 2 }, data: button.action.data } };
      }
      if (button.action.type === 1) {
        if (!exact(button.action, ["type", "permission", "data", "unsupport_tips"])
          || typeof button.action.unsupport_tips !== "string" || !button.action.unsupport_tips.trim()
          || [...button.action.unsupport_tips].length > 100 || !wellFormed(button.action.unsupport_tips)
          || /\p{Cc}/u.test(button.action.unsupport_tips)) return fail();
        // Callback buttons keep their label after a click; omission can render blank.
        return { id: button.id, render_data: { label: button.render_data.label, visited_label: button.render_data.label, style: button.render_data.style },
          action: { type: 1, permission: { type: 2 }, data: button.action.data, unsupport_tips: button.action.unsupport_tips } };
      }
      if (!exact(button.action, ["type", "permission", "data", "enter", "reply"])
        || button.action.type !== 2 || typeof button.action.enter !== "boolean" || button.action.reply !== false) return fail();
      return { id: button.id, render_data: { label: button.render_data.label, visited_label: button.render_data.label, style: button.render_data.style },
        action: { type: 2 as const, permission: { type: 2 as const }, data: button.action.data,
          enter: button.action.enter, reply: false as const } };
    }) };
  });
  return { content: { rows } };
}

function wellFormed(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && Buffer.byteLength(value) <= 512 && !/[\s\p{Cc}]/u.test(value) && wellFormed(value);
}

function recipient(value: unknown): value is QqRecipient {
  return identifier(value) || record(value) && Object.keys(value).length === 1 && identifier(value.groupOpenId);
}

function recipientPath(value: QqRecipient, resource: "messages" | "files"): string {
  return typeof value === "string" ? `/v2/users/${encodeURIComponent(value)}/${resource}`
    : `/v2/groups/${encodeURIComponent(value.groupOpenId)}/${resource}`;
}

// Only documented, unambiguous message rejections are classified as definitely rejected.
function textRejection(code: number): QqTextRejection | undefined {
  switch (code) {
    case 40034105: case 40034024: case 40054004: return "permission";
    case 40054013: return "refused";
    case 304103: case 40034005: case 40034026: return "expired";
    case 40034128: return "reply-window-or-limit";
    case 40034100: return "rate-limit";
    case 40054005: return "duplicate";
    case 40054007: case 40054018: return "length";
    case 22006: case 50059: case 304061: case 40034011: case 40034124: return "format";
    case 40034006: return "content";
    case 40054016: return "unavailable";
    default: return undefined;
  }
}

async function readTextResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const traceId = safeTraceId(response.headers.get("x-tps-trace-id"));
  if (response.redirected) {
    void response.body?.cancel().catch(() => undefined);
    throw new QqProtocolError("message", "http", response.status, undefined, traceId);
  }
  let data: unknown;
  const raw = await readBody(response, signal, "message");
  try { data = JSON.parse(raw); }
  catch { throw new QqProtocolError("message", "invalid-response", response.status, undefined, traceId); }
  if (!record(data)) throw new QqProtocolError("message", "invalid-response", response.status, undefined, traceId);
  const trace = traceId ?? safeTraceId(data.trace_id);
  const codes = ["code", "err_code"].filter(key => Object.hasOwn(data, key)).map(key => data[key]);
  if (codes.some(code => typeof code !== "number" || !Number.isSafeInteger(code))
    || (codes.length === 2 && codes[0] !== codes[1])) {
    throw new QqProtocolError("message", "invalid-response", response.status, undefined, trace);
  }
  const code = codes[0] as number | undefined;
  if (code !== undefined && code !== 0) {
    // An ID alongside an error, or an upstream 5xx, does not establish non-delivery.
    if (Object.hasOwn(data, "id") || !(response.status === 200 || (response.status >= 400 && response.status < 500))) {
      throw new QqProtocolError("message", "invalid-response", response.status, code, trace);
    }
    throw new QqProtocolError("message", "business", response.status, code, trace);
  }
  if (response.status !== 200) throw new QqProtocolError("message", "http", response.status, code, trace);
  if (typeof data.id !== "string" || !/^[\x21-\x7e]{1,512}$/.test(data.id)) {
    throw new QqProtocolError("message", "invalid-response", response.status, code, trace);
  }
  signal.throwIfAborted();
  return { id: data.id };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

async function readBody(response: Response, signal: AbortSignal, operation: QqProtocolOperation): Promise<string> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new QqProtocolError(operation, "cancelled");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new QqProtocolError(operation, "response-too-large");
  }
  if (!response.body) throw new QqProtocolError(operation, "invalid-response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
        catch { throw new QqProtocolError(operation, "invalid-response"); }
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        cancel();
        throw new QqProtocolError(operation, "response-too-large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, operation: QqProtocolOperation): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) {
    // Work may synchronously abort while creating this promise. Consume its later rejection
    // even though cancellation must return immediately instead of waiting for that work.
    void promise.catch(() => {});
    throw new QqProtocolError(operation, "cancelled");
  }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new QqProtocolError(operation, "cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
