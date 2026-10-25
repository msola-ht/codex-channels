import type { Logger } from "pino";
import { join } from "node:path";
import { safeInteractionDecision, type InteractionPort } from "../../approval/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import type { SurfaceAdapter, SurfaceOutputPort } from "../types.js";
import type { QqNetwork } from "./network.js";
import { QqProtocolClient, QqProtocolError } from "./protocol.js";
import { QqWebSocketTransport, QqTransportError } from "./transport.js";
import { QqMessages, type QqMessageOptions } from "./messages.js";
import { QqImageStore } from "./image-store.js";
import { QqFileInput } from "./file-input.js";

export interface CreateQqSurfaceOptions extends QqMessageOptions {
  appId: string;
  appSecret: string;
  uploadsDirectory: string;
  createNetwork(): QqNetwork;
  access: SurfaceAccessPolicy;
  logger: Logger;
  onFatal(error: Error): void;
}

/** Shares Application and persistent delivery with other Surfaces. */
export class QqSurface implements SurfaceAdapter {
  readonly surface = "qq";
  readonly capabilities = { recoverBindings: true, interactions: true, scheduledTasks: false, configurationNotifications: false } as const;
  readonly accountId: string;
  readonly interactions: InteractionPort = {
    request: (target, request) => this.current?.messages.interactions.request(target, request) ?? Promise.resolve(safeInteractionDecision(request)),
    resolved: id => this.current?.messages.interactions.resolved(id),
    cancelAll: () => this.current?.messages.interactions.cancelAll(),
  };
  readonly takeAsyncAnswerSubmission = (target: Parameters<QqMessages["takeAsyncAnswerSubmission"]>[0], requestId: string) =>
    this.current?.messages.takeAsyncAnswerSubmission(target, requestId);
  readonly output: SurfaceOutputPort = {
    deliverySource: {
      capture: event => this.current?.messages.deliverySource.capture(event),
      await: (reference, signal) => this.current?.messages.deliverySource.await(reference, signal) ?? Promise.resolve(false),
      current: reference => this.current?.messages.deliverySource.current(reference) === true,
    },
    admitLive: event => this.current?.messages.admitLive(event),
    observe: event => this.current?.messages.observe(event),
    retains: event => this.current?.messages.retains(event) === true,
    handle: (event, context, signal) => this.current?.messages.handle(event, context, signal),
    deliver: (event, signal, checkpoint, authorized) => this.current?.messages.deliver(event, signal, checkpoint, authorized)
      ?? Promise.reject(new Error("QQ 消息连接不可用")),
  };
  private current: QqConnection | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;
  private terminalFailure: QqTransportError | undefined;
  private startupAttempted = false;

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
    if (!this.startupAttempted) {
      this.startupAttempted = true;
      connection.messages.startNotifications();
    }
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

  sendChannelImage(conversationId: string, imagePath: string, isCurrent: () => boolean): Promise<void> {
    return this.current?.messages.sendChannelImage(conversationId, imagePath, isCurrent)
      ?? Promise.reject(new Error("QQ 消息连接不可用"));
  }

  sendChannelFile(conversationId: string, filePath: string, fileName: string, isCurrent: () => boolean): Promise<void> {
    return this.current?.messages.sendChannelFile(conversationId, filePath, fileName, isCurrent)
      ?? Promise.reject(new Error("QQ 消息连接不可用"));
  }

  deliverConfigurationChange(): Promise<void> {
    // Startup notifications are independent of configuration broadcasts.
    // This disabled broadcast must not block other channels' durable events.
    return Promise.resolve();
  }
}

class QqConnection {
  readonly messages: QqMessages;
  private readonly network: QqNetwork;
  private readonly client: QqProtocolClient;
  private readonly transport: QqWebSocketTransport;
  private readonly images: QqImageStore;
  private readonly files: QqFileInput;
  private closed = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: CreateQqSurfaceOptions) {
    // Validate credentials before acquiring network resources.
    this.client = new QqProtocolClient({ appId: options.appId, appSecret: options.appSecret,
      fetchImpl: (input, init) => this.network.fetchImpl(input, init) });
    this.network = options.createNetwork();
    this.images = new QqImageStore(join(options.uploadsDirectory, `qq-images-${options.appId}`),
      (url, signal, guard) => this.network.downloadAttachment(url, signal, guard), options.logger);
    this.files = new QqFileInput(join(options.uploadsDirectory, `qq-text-${options.appId}`),
      (url, signal, guard) => this.network.downloadAttachment(url, signal, guard), options.logger,
      join(options.uploadsDirectory, `qq-files-${options.appId}`));
    this.messages = new QqMessages({ ...options, images: this.images, files: this.files }, this.client);
    this.transport = new QqWebSocketTransport({
      client: this.client,
      agentForUrl: (url, signal) => this.network.agentForUrl(url, signal),
      releaseAgent: agent => this.network.releaseAgent(agent),
      onDispatch: (event, signal) => Promise.resolve().then(() => {
        signal.throwIfAborted();
        if (this.closed) return;
        this.messages.receive(event);
      }),
      onStatus: status => options.logger.info({ surface: "qq", accountId: options.appId, status },
        "QQ 文字渠道连接状态；连接就绪不代表任务送达"),
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
    this.images.close();
    this.client.close();
    return this.stopping ??= this.closeResources();
  }

  private async closeResources(): Promise<void> {
    const work = Promise.allSettled([this.messages.close(), this.files.close(), this.transport.stop(), this.network.close()]).then(results => {
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
