import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { InitializeResponse, RequestId } from "../codex-protocol/index.js";
import gatewayMetadata from "../version.json" with { type: "json" };
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

export interface ProtocolLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

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
  private readonly serverRequestTasks = new Set<Promise<void>>();
  private serverRequestHandler?: ServerRequestHandler;
  private removeMessageHandler: (() => void) | undefined;
  private removeCloseHandler: (() => void) | undefined;
  private state: "idle" | "connecting" | "connected" | "closing" = "idle";
  private connectionGeneration = 0;

  constructor(
    private readonly transport: CodexTransport,
    private readonly requestTimeoutMs = 60_000,
    private readonly logger?: ProtocolLogger,
    private readonly maximumServerRequests = 64,
  ) {}

  async connect(): Promise<InitializeResponse> {
    if (this.state !== "idle") {
      throw new Error(`Codex JSON-RPC Client 当前状态不允许连接：${this.state}`);
    }
    this.state = "connecting";
    this.connectionGeneration += 1;
    this.installTransportHandlers();
    try {
      await this.transport.connect();
      const response = await this.request<InitializeResponse>(
        "initialize",
        {
          clientInfo: {
            name: "codex_connect_gateway",
            title: "Codex Connect Gateway",
            version: gatewayMetadata.version,
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: null,
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
    this.connectionGeneration += 1;
    this.serverRequestTasks.clear();
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
      this.logger?.warn({ reason: "invalid-json" }, "忽略无效 Codex JSON-RPC 消息");
      return;
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      this.logger?.warn({ reason: "invalid-envelope" }, "忽略无效 Codex JSON-RPC 消息");
      return;
    }
    const message = parsed.data;

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.logger?.warn({ requestId: message.id }, "忽略没有对应请求的 Codex JSON-RPC 响应");
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
      this.dispatchServerRequest({
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

  private dispatchServerRequest(request: RpcServerRequest): void {
    const generation = this.connectionGeneration;
    if (this.serverRequestTasks.size >= this.maximumServerRequests) {
      const task = this.sendServerResponse(
        request,
        generation,
        undefined,
        new JsonRpcError(-32000, "Client overloaded; request rejected."),
      );
      this.trackServerRequest(task);
      return;
    }
    this.trackServerRequest(this.handleServerRequest(request, generation));
  }

  private trackServerRequest(task: Promise<void>): void {
    const guarded = task.catch((error) => {
      this.logger?.warn(
        { err: asError(error), reason: "server-request-task" },
        "Codex Server Request 处理任务失败",
      );
    });
    this.serverRequestTasks.add(guarded);
    void guarded.finally(() => this.serverRequestTasks.delete(guarded));
  }

  private async handleServerRequest(request: RpcServerRequest, generation: number): Promise<void> {
    let result: unknown;
    let rpcError: JsonRpcError | undefined;
    try {
      if (!this.serverRequestHandler) {
        throw new JsonRpcError(-32601, `Unsupported server request: ${request.method}`);
      }
      result = await this.serverRequestHandler(request);
    } catch (error) {
      rpcError =
        error instanceof JsonRpcError
          ? error
          : new JsonRpcError(-32603, "Internal client error");
    }
    await this.sendServerResponse(request, generation, result, rpcError);
  }

  private async sendServerResponse(
    request: RpcServerRequest,
    generation: number,
    result: unknown,
    error?: JsonRpcError,
  ): Promise<void> {
    if (
      generation !== this.connectionGeneration ||
      (this.state !== "connected" && this.state !== "connecting")
    ) {
      this.logger?.warn(
        { method: request.method, requestId: request.id, reason: "stale-connection" },
        "Codex Server Request 已失效，不向旧连接发送响应",
      );
      return;
    }
    const response = error
      ? { id: request.id, error: { code: error.code, message: error.message, data: error.data } }
      : { id: request.id, result };
    try {
      await this.transport.send(JSON.stringify(response));
    } catch (sendError) {
      this.logger?.warn(
        { err: asError(sendError), method: request.method, requestId: request.id, reason: "response-send" },
        "Codex Server Request 响应发送失败",
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
        this.connectionGeneration += 1;
        this.serverRequestTasks.clear();
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
