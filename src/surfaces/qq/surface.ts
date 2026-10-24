import type { Logger } from "pino";
import { safeInteractionDecision, type InteractionPort } from "../../approval/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import type { SurfaceAdapter, SurfaceOutputPort } from "../types.js";
import type { QqNetwork } from "./network.js";
import { QqProtocolClient, QqProtocolError } from "./protocol.js";
import { QqWebSocketTransport, QqTransportError } from "./transport.js";

export interface CreateQqSurfaceOptions {
  appId: string;
  appSecret: string;
  createNetwork(): QqNetwork;
  access: SurfaceAccessPolicy;
  logger: Logger;
  onFatal(error: Error): void;
}

/** Connection-only adapter. No Application capabilities are available in this phase. */
export class QqSurface implements SurfaceAdapter {
  readonly surface = "qq";
  readonly connectionOnly = true;
  readonly accountId: string;
  readonly interactions: InteractionPort = {
    request: (_target, request) => Promise.resolve(safeInteractionDecision(request)),
    resolved: () => {},
    cancelAll: () => {},
  };
  readonly output: SurfaceOutputPort = {
    handle: () => { throw new Error("QQ 消息层尚未接入，输出未发送"); },
    deliver: () => Promise.reject(new Error("QQ 消息层尚未接入，输出未发送")),
  };
  private current: QqConnection | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;
  private terminalFailure: QqTransportError | undefined;

  constructor(private readonly options: CreateQqSurfaceOptions) {
    this.accountId = options.appId;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("QQ 已关闭"));
    if (this.terminalFailure) return Promise.reject(this.terminalFailure);
    return this.starting ??= this.begin().finally(() => { this.starting = undefined; });
  }

  private async begin(): Promise<void> {
    await this.current?.stop();
    if (this.closed) throw new Error("QQ 已关闭");
    if (this.terminalFailure) throw this.terminalFailure;
    const connection = new QqConnection({ ...this.options, onFatal: error => {
      this.rememberTerminalFailure(error);
      this.options.onFatal(error);
    } });
    this.current = connection;
    try { await connection.start(); }
    catch (error) {
      this.rememberTerminalFailure(error);
      if (!this.closed) logConnectionFailure(this.options, error);
      await connection.stop();
      throw error;
    }
    if (this.closed) { await connection.stop(); throw new Error("QQ 已关闭"); }
  }

  private rememberTerminalFailure(error: unknown): void {
    if (error instanceof QqTransportError && error.reason === "fatal-close" && error.closeCode !== undefined) {
      this.terminalFailure = error;
    }
  }

  stop(): Promise<void> {
    this.closed = true;
    return this.stopping ??= Promise.all([
      this.current?.stop(), this.starting?.catch(() => {}),
    ]).then(() => {});
  }

  deliverConfigurationChange(): Promise<void> {
    // This connection-only adapter has no notification recipients. An empty
    // broadcast must not prevent other channels' durable events being acknowledged.
    return Promise.resolve();
  }
}

class QqConnection {
  private readonly network: QqNetwork;
  private readonly client: QqProtocolClient;
  private readonly transport: QqWebSocketTransport;
  private closed = false;
  private stopping: Promise<void> | undefined;
  private observedIgnoredInput = false;

  constructor(private readonly options: CreateQqSurfaceOptions) {
    // Validate credentials before acquiring network resources.
    this.client = new QqProtocolClient({ appId: options.appId, appSecret: options.appSecret,
      fetchImpl: (input, init) => this.network.fetchImpl(input, init) });
    this.network = options.createNetwork();
    this.transport = new QqWebSocketTransport({
      client: this.client,
      agentForUrl: (url, signal) => this.network.agentForUrl(url, signal),
      releaseAgent: agent => this.network.releaseAgent(agent),
      onDispatch: (event, signal) => Promise.resolve().then(() => {
        signal.throwIfAborted();
        if (this.closed || event.t !== "C2C_MESSAGE_CREATE") return;
        const value = event.d;
        const author = value && typeof value === "object" && "author" in value ? value.author : undefined;
        const actor = author && typeof author === "object" && "user_openid" in author ? author.user_openid : undefined;
        if (typeof actor !== "string" || !options.access.isAllowed({
          target: { surface: "qq", accountId: options.appId, conversationId: `c2c:${actor}` }, actorId: actor,
        })) return;
        if (!this.observedIgnoredInput) {
          this.observedIgnoredInput = true;
          options.logger.warn({ surface: "qq", accountId: options.appId, reason: "message-layer-unavailable" },
            "QQ 已收到允许用户的事件，但消息层尚未接入；本代次不提交任务、不回复，事件不会留存或重放");
        }
      }),
      onStatus: status => options.logger.info({ surface: "qq", accountId: options.appId, status },
        "QQ 基础连接状态；消息层尚未接入，不代表收发可用"),
    });
    void this.transport.finished.catch((error: unknown) => {
      if (this.closed) return;
      logConnectionFailure(options, error);
      this.options.onFatal(error instanceof Error ? error : new Error("QQ 连接失败"));
      void this.stop().catch(() => options.logger.warn({ reason: "qq-close-unconfirmed" }, "QQ 连接资源关闭未确认"));
    });
  }

  start(): Promise<void> { return this.transport.start(); }

  stop(): Promise<void> {
    this.closed = true;
    this.client.close();
    return this.stopping ??= this.closeResources();
  }

  private async closeResources(): Promise<void> {
    const work = Promise.allSettled([this.transport.stop(), this.network.close()]).then(results => {
      if (results.some(result => result.status === "rejected")) throw new Error("QQ 连接资源关闭未确认");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("QQ 连接资源关闭超时")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  }
}

function logConnectionFailure(options: CreateQqSurfaceOptions, error: unknown): void {
  // Shared Error serialization intentionally omits arbitrary messages and fields.
  // Publish only QQ's locally classified diagnostics, never upstream response text.
  options.logger.warn({ surface: "qq", accountId: options.appId,
    ...(error instanceof QqProtocolError ? {
      operation: error.operation, reason: error.reason, httpStatus: error.httpStatus,
      bizCode: error.bizCode, traceId: error.traceId,
    } : error instanceof QqTransportError ? {
      operation: "websocket", reason: error.reason, closeCode: error.closeCode,
    } : { reason: "connection-failed" }),
  }, "QQ 基础连接失败");
}
