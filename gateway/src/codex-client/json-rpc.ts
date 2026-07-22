import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { InitializeResponse, RequestId } from "../codex-protocol/index.js";
import type { CodexTransport } from "./transport.js";

const envelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface RpcServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

export type ServerRequestHandler = (request: RpcServerRequest) => Promise<unknown>;

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: RpcNotification) => void>();
  private readonly disconnectHandlers = new Set<(error: Error) => void>();
  private serverRequestHandler?: ServerRequestHandler;
  private removeMessageHandler: (() => void) | undefined;
  private removeCloseHandler: (() => void) | undefined;
  private state: "idle" | "connecting" | "connected" | "closing" = "idle";

  constructor(
    private readonly transport: CodexTransport,
    private readonly requestTimeoutMs = 60_000,
  ) {}

  async connect(): Promise<InitializeResponse> {
    if (this.state !== "idle") {
      throw new Error(`Codex JSON-RPC Client 当前状态不允许连接：${this.state}`);
    }
    this.state = "connecting";
    this.installTransportHandlers();
    try {
      await this.transport.connect();
      const response = await this.request<InitializeResponse>(
        "initialize",
        {
          clientInfo: {
            name: "codex_tg_gateway",
            title: "Codex Telegram Gateway",
            version: "0.2.0",
          },
        },
        { retryOverload: false },
      );
      await this.notify("initialized", {});
      this.state = "connected";
      return response;
    } catch (error) {
      this.state = "idle";
      this.failPending(asError(error));
      await this.transport.close().catch(() => undefined);
      throw error;
    }
  }

  async reconnect(): Promise<InitializeResponse> {
    if (this.state !== "idle") {
      throw new Error(`Codex JSON-RPC Client 当前状态不允许重连：${this.state}`);
    }
    await this.transport.close().catch(() => undefined);
    return this.connect();
  }

  async close(): Promise<void> {
    if (this.state === "closing") {
      return;
    }
    this.state = "closing";
    this.removeMessageHandler?.();
    this.removeCloseHandler?.();
    this.removeMessageHandler = undefined;
    this.removeCloseHandler = undefined;
    this.failPending(new Error("Codex JSON-RPC Client 已关闭"));
    await this.transport.close();
    this.state = "idle";
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async request<T>(
    method: string,
    params: unknown,
    options: { retryOverload: boolean; attempts?: number } = { retryOverload: false },
  ): Promise<T> {
    const attempts = options.retryOverload ? (options.attempts ?? 4) : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestOnce<T>(method, params);
      } catch (error) {
        if (!(error instanceof JsonRpcError) || error.code !== -32001 || attempt === attempts) {
          throw error;
        }
        const base = Math.min(2_000, 100 * 2 ** (attempt - 1));
        await delay(base + Math.floor(Math.random() * base));
      }
    }
    throw new Error("无法完成 JSON-RPC 请求");
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.transport.send(JSON.stringify({ method, params }));
  }

  private async requestOnce<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex JSON-RPC 请求超时：${method}`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });

    try {
      await this.transport.send(JSON.stringify({ method, id, params }));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return (await response) as T;
  }

  private handleMessage(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      });
      return;
    }

    if (message.method !== undefined) {
      const notification = { method: message.method, params: message.params ?? {} };
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private async handleServerRequest(request: RpcServerRequest): Promise<void> {
    try {
      if (!this.serverRequestHandler) {
        throw new JsonRpcError(-32601, `Unsupported server request: ${request.method}`);
      }
      const result = await this.serverRequestHandler(request);
      await this.transport.send(JSON.stringify({ id: request.id, result }));
    } catch (error) {
      const rpcError =
        error instanceof JsonRpcError
          ? error
          : new JsonRpcError(-32603, "Internal client error");
      await this.transport.send(
        JSON.stringify({
          id: request.id,
          error: { code: rpcError.code, message: rpcError.message, data: rpcError.data },
        }),
      );
    }
  }

  private installTransportHandlers(): void {
    if (!this.removeMessageHandler) {
      this.removeMessageHandler = this.transport.onMessage((message) => this.handleMessage(message));
    }
    if (!this.removeCloseHandler) {
      this.removeCloseHandler = this.transport.onClose((error) => {
        if (this.state !== "connected" && this.state !== "connecting") {
          return;
        }
        const disconnectError = error ?? new Error("Codex App Server 连接已关闭");
        this.state = "idle";
        this.failPending(disconnectError);
        for (const handler of this.disconnectHandlers) {
          handler(disconnectError);
        }
      });
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
