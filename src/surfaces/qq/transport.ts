import type { Agent } from "node:http";
import WebSocket, { type RawData } from "ws";

import { QqProtocolClient, QqProtocolError } from "./protocol.js";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PENDING_DISPATCHES = 32;
const DISPATCH_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000] as const;

export interface QqDispatchEnvelope {
  op: 0;
  t: string;
  s: number;
  id?: string;
  d: unknown;
}

export type QqConnectionStatus = "connecting" | "ready" | "disconnected" | "stopped";
export type QqTransportFailure =
  | "stopped" | "timeout" | "invalid-payload" | "overloaded"
  | "dispatch-failed" | "dispatch-timeout" | "fatal-close" | "retry-exhausted"
  | "status-failed" | "shutdown-unconfirmed";

export class QqTransportError extends Error {
  constructor(readonly reason: QqTransportFailure, readonly closeCode?: number) {
    super(`QQ websocket: ${reason}`);
    this.name = "QqTransportError";
  }
}

export interface QqWebSocketTransportOptions {
  client: QqProtocolClient;
  agent?: Agent;
  agentForUrl?: (url: string, signal: AbortSignal) => Agent | undefined;
  releaseAgent?: (agent: Agent) => Promise<void>;
  /** Must resolve after bounded admission, rather than waiting for a model turn. */
  onDispatch: (envelope: QqDispatchEnvelope, signal: AbortSignal) => Promise<void>;
  /** Synchronous local state notification; exceptions fail the transport closed. */
  onStatus?: (status: QqConnectionStatus) => void;
}

/** Account-owned, single-use WebSocket with separate startup and runtime completion. */
export class QqWebSocketTransport {
  readonly finished: Promise<void>;
  private resolveFinished: () => void = () => {};
  private rejectFinished: (error: Error) => void = () => {};
  private readonly lifetime = new AbortController();
  private readonly socketClosures = new Map<WebSocket, Promise<void>>();
  private readonly callbacks = new Set<Promise<void>>();
  private runTask: Promise<void> | undefined;
  private cleanupTask: Promise<void> | undefined;
  private done = false;
  private startup: Promise<void> | undefined;
  private resolveStartup: () => void = () => {};
  private rejectStartup: (error: Error) => void = () => {};
  private startupTimeout: ReturnType<typeof setTimeout> | undefined;
  private sessionId: string | undefined;
  private lastSeq: number | null = null;

  constructor(private readonly options: QqWebSocketTransportOptions) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    // The owner can attach its lifecycle observer after construction/start.
    void this.finished.catch(() => undefined);
  }

  start(): Promise<void> {
    if (this.startup) return this.startup;
    this.startup = new Promise<void>((resolve, reject) => {
      this.resolveStartup = resolve;
      this.rejectStartup = reject;
    });
    if (this.done) {
      this.rejectStartup(new QqTransportError("stopped"));
      return this.startup;
    }
    this.startupTimeout = setTimeout(() => this.finish(new QqTransportError("timeout")), START_TIMEOUT_MS);
    this.startupTimeout.unref();
    this.runTask = Promise.resolve().then(() => this.run());
    void this.runTask.then(() => this.finish(), (error: unknown) => {
      this.finish(error instanceof QqTransportError || error instanceof QqProtocolError
        ? error : new QqTransportError("fatal-close"));
    });
    return this.startup;
  }

  async stop(): Promise<void> {
    this.finish();
    await this.cleanupTask;
  }

  private status(status: QqConnectionStatus): void {
    if (this.done && status !== "stopped") return;
    try { this.options.onStatus?.(status); }
    catch { throw new QqTransportError("status-failed"); }
  }

  private finish(error?: Error): void {
    if (this.done) return;
    try { this.status("disconnected"); }
    catch { error ??= new QqTransportError("status-failed"); }
    this.done = true;
    this.lifetime.abort();
    if (this.startupTimeout) clearTimeout(this.startupTimeout);
    for (const socket of this.socketClosures.keys()) socket.terminate();
    this.cleanupTask = this.awaitShutdown();
    void this.cleanupTask.then(() => {
      try { this.status("stopped"); }
      catch { error ??= new QqTransportError("status-failed"); }
      this.rejectStartup(error ?? new QqTransportError("stopped"));
      if (error) this.rejectFinished(error);
      else this.resolveFinished();
    }, (shutdownError: unknown) => {
      const failure = shutdownError instanceof QqTransportError
        ? shutdownError : new QqTransportError("shutdown-unconfirmed");
      this.rejectStartup(failure);
      this.rejectFinished(failure);
    });
  }

  private async awaitShutdown(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new QqTransportError("shutdown-unconfirmed")), SHUTDOWN_TIMEOUT_MS);
    });
    const actualExit = (async () => {
      await this.runTask?.catch(() => undefined);
      // Keep ownership of callbacks which ignore cancellation, even after the shutdown deadline.
      await Promise.allSettled([...this.callbacks]);
      await Promise.all([...this.socketClosures.values()]);
    })();
    try { await Promise.race([actualExit, expired]); }
    finally { if (timeout) clearTimeout(timeout); }
  }

  private async run(): Promise<void> {
    let reconnects = 0;
    while (!this.lifetime.signal.aborted) {
      this.status("connecting");
      let closeCode: number | undefined;
      try {
        const url = await this.options.client.getGatewayUrl(this.lifetime.signal);
        const token = await this.options.client.getAccessToken(this.lifetime.signal);
        if (this.lifetime.signal.aborted) return;
        closeCode = await this.connect(url, token);
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        if (error instanceof QqTransportError) throw error;
        // Token/credential/configuration and business failures are never hidden by reconnection.
        if (error instanceof QqProtocolError
          && !["network", "timeout"].includes(error.reason)) throw error;
      }
      if (this.lifetime.signal.aborted) return;
      this.status("disconnected");
      // API V2's per-code table takes precedence over its abbreviated retry advice.
      if (closeCode !== undefined && [4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(closeCode)) {
        throw new QqTransportError("fatal-close", closeCode);
      }
      if (closeCode === 4004) this.options.client.invalidateAccessToken();
      // 4009 retains the session and admitted sequence so Resume can replay missed events.
      if (closeCode === 4006 || closeCode === 4007
        || (closeCode !== undefined && closeCode >= 4900 && closeCode <= 4913)) {
        this.sessionId = undefined;
        this.lastSeq = null;
        this.options.client.invalidateAccessToken();
      }
      const delay = RECONNECT_DELAYS[reconnects++];
      if (delay === undefined) throw new QqTransportError("retry-exhausted", closeCode);
      // The finite budget is lifetime-wide, including rapid READY→close loops.
      await this.delay(closeCode === 4008 ? 60_000 : closeCode === 4006 ? 3000 : delay);
    }
  }

  private async connect(url: string, token: string): Promise<number> {
    const connection = new AbortController();
    const connectionSignal = AbortSignal.any([this.lifetime.signal, connection.signal]);
    const agent = this.options.agentForUrl ? this.options.agentForUrl(url, connectionSignal) : this.options.agent;
    const ws = new WebSocket(url, {
      ...(agent ? { agent } : {}),
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_PAYLOAD_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    });
    const closed = new Promise<void>((resolve) => ws.once("close", () => {
      this.socketClosures.delete(ws);
      resolve();
    }));
    this.socketClosures.set(ws, closed);
    const signal = this.lifetime.signal;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let awaitingHeartbeat = false;
    let helloReceived = false;
    let connected = false;
    let resuming = false;
    let settled = false;
    let pending = 0;
    let dispatchTail = Promise.resolve();
    let rejectConnection: (error: Error) => void = () => {};
    const send = (payload: Record<string, unknown>) => {
      if (settled || signal.aborted || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_PAYLOAD_BYTES) {
        rejectConnection(new QqTransportError("overloaded"));
        return;
      }
      ws.send(JSON.stringify(payload), (error) => {
        if (error && !settled) ws.terminate();
      });
    };
    const outcome = new Promise<number>((resolve, reject) => {
      const settle = (code?: number, error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(code ?? 1006);
      };
      rejectConnection = (error) => settle(undefined, error);
      ws.on("error", () => ws.terminate());
      ws.on("close", (code) => settle(code));
      ws.on("message", (raw: RawData, binary: boolean) => {
        if (settled || signal.aborted) return;
        let payload: Record<string, unknown>;
        try {
          if (binary) throw new QqTransportError("invalid-payload");
          const bytes = Array.isArray(raw) ? Buffer.concat(raw)
            : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
          const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (!record(decoded) || !Number.isSafeInteger(decoded.op)) {
            throw new QqTransportError("invalid-payload");
          }
          payload = decoded;
          switch (payload.op) {
            case 10: {
              if (helloReceived || !record(payload.d)
                || typeof payload.d.heartbeat_interval !== "number"
                || !Number.isSafeInteger(payload.d.heartbeat_interval)
                || payload.d.heartbeat_interval < 1000 || payload.d.heartbeat_interval > 120_000) {
                throw new QqTransportError("invalid-payload");
              }
              helloReceived = true;
              resuming = this.sessionId !== undefined && this.lastSeq !== null;
              send(resuming
                ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } }
                : { op: 2, d: { token: `QQBot ${token}`, intents: (1 << 25) | (1 << 26), shard: [0, 1] } });
              heartbeat = setInterval(() => {
                if (awaitingHeartbeat) { ws.terminate(); return; }
                awaitingHeartbeat = true;
                send({ op: 1, d: this.lastSeq });
              }, payload.d.heartbeat_interval);
              heartbeat.unref();
              break;
            }
            case 11:
              awaitingHeartbeat = false;
              break;
            case 1:
              send({ op: 1, d: this.lastSeq });
              break;
            case 7:
              settle(1000);
              break;
            case 9:
              if (typeof payload.d !== "boolean") throw new QqTransportError("invalid-payload");
              settle(payload.d ? 1000 : 4006);
              break;
            case 0: {
              if (!helloReceived || typeof payload.t !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(payload.t)
                || typeof payload.s !== "number" || !Number.isSafeInteger(payload.s) || payload.s < 0
                || (payload.id !== undefined && (typeof payload.id !== "string" || payload.id.length > 512))) {
                throw new QqTransportError("invalid-payload");
              }
              if (pending >= MAX_PENDING_DISPATCHES) throw new QqTransportError("overloaded");
              const envelope: QqDispatchEnvelope = {
                ...payload, op: 0, t: payload.t, s: payload.s, d: payload.d,
                ...(typeof payload.id === "string" ? { id: payload.id } : {}),
              };
              pending++;
              dispatchTail = dispatchTail.then(async () => {
                if (signal.aborted) return;
                if (envelope.t === "READY") {
                  if (connected || resuming || !record(envelope.d)
                    || typeof envelope.d.session_id !== "string"
                    || !/^[\x21-\x7e]{1,512}$/.test(envelope.d.session_id)) {
                    throw new QqTransportError("invalid-payload");
                  }
                  this.sessionId = envelope.d.session_id;
                } else if (envelope.t === "RESUMED") {
                  if (connected || !resuming || !this.sessionId) throw new QqTransportError("invalid-payload");
                } else if (!connected && !resuming) {
                  throw new QqTransportError("invalid-payload");
                }
                await this.dispatch(envelope);
                if (signal.aborted) return;
                // Advance only after upper-layer admission completed; never on receipt alone.
                this.lastSeq = envelope.s;
                if (envelope.t === "READY" || envelope.t === "RESUMED") {
                  connected = true;
                  clearTimeout(connectionTimeout);
                  if (!settled) {
                    this.status("ready");
                    if (this.startupTimeout) clearTimeout(this.startupTimeout);
                    this.resolveStartup();
                  }
                }
              }).finally(() => { pending--; });
              void dispatchTail.catch((error: unknown) => {
                rejectConnection(error instanceof QqTransportError ? error : new QqTransportError("dispatch-failed"));
              });
              break;
            }
            default:
              throw new QqTransportError("invalid-payload");
          }
        } catch (error) {
          rejectConnection(error instanceof QqTransportError ? error : new QqTransportError("invalid-payload"));
        }
      });
    });
    const connectionTimeout = setTimeout(() => ws.terminate(), CONNECT_TIMEOUT_MS);
    connectionTimeout.unref();
    const stop = () => { ws.terminate(); rejectConnection(new QqTransportError("stopped")); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const code = await outcome;
      // Preserve admitted work ordering before another connection can replay events.
      await dispatchTail;
      return code;
    } finally {
      settled = true;
      signal.removeEventListener("abort", stop);
      clearTimeout(connectionTimeout);
      if (heartbeat) clearInterval(heartbeat);
      ws.terminate();
      connection.abort();
      if (agent && this.options.releaseAgent) await this.options.releaseAgent(agent);
    }
  }

  private async dispatch(envelope: QqDispatchEnvelope): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), DISPATCH_TIMEOUT_MS);
    timeout.unref();
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal]);
    if (signal.aborted) {
      clearTimeout(timeout);
      throw new QqTransportError("stopped");
    }
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new QqTransportError(deadline.signal.aborted ? "dispatch-timeout" : "stopped"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const callback = Promise.resolve().then(async () => {
        if (!signal.aborted) await this.options.onDispatch(envelope, signal);
      });
      this.callbacks.add(callback);
      void callback.finally(() => this.callbacks.delete(callback)).catch(() => undefined);
      await Promise.race([callback, cancelled]);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      deadline.abort();
    }
  }

  private async delay(ms: number): Promise<void> {
    const signal = this.lifetime.signal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const stop = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
      timeout.unref();
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
