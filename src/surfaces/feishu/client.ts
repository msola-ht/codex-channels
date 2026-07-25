import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  defaultHttpInstance,
  type HttpInstance,
  type HttpRequestOptions,
  type Logger,
} from "@larksuiteoapi/node-sdk";

import {
  decodeFeishuMessageEvent,
  FeishuMessageEventError,
  type FeishuMessageEvent,
} from "./message-event.js";
import { encodeFeishuPostContent } from "./message-content.js";
import type { FeishuMessagePort } from "./outbox.js";

const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/u;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

export type FeishuConnectionState =
  | "idle"
  | "starting"
  | "running"
  | "reconnecting"
  | "failed"
  | "stopped";

export type FeishuConnectionErrorCode =
  | "invalid-credentials"
  | "start-failed"
  | "start-timeout"
  | "stopped";

export class FeishuConnectionError extends Error {
  readonly code: FeishuConnectionErrorCode;

  constructor(code: FeishuConnectionErrorCode, message: string) {
    super(message);
    this.name = "FeishuConnectionError";
    this.code = code;
  }
}

export interface FeishuEventConnectionOptions {
  appId: string;
  appSecret: string;
  webSocketAgent?: unknown;
  onMessage(event: FeishuMessageEvent): void;
  onInvalidMessage(error: FeishuMessageEventError): void;
  onReconnecting?(): void;
  onReconnected?(): void;
  onFatal(error: FeishuConnectionError): void;
}

interface FeishuSdkCallbacks {
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

interface FeishuSdkConnection {
  registerMessageHandler(handler: (event: unknown) => void): void;
  start(): Promise<void>;
  close(force: boolean): void;
}

interface FeishuEventConnectionDependencies {
  startupTimeoutMs: number;
  createSdkConnection(
    options: Pick<
      FeishuEventConnectionOptions,
      "appId" | "appSecret" | "webSocketAgent"
    >,
    callbacks: FeishuSdkCallbacks,
  ): FeishuSdkConnection;
}

export interface FeishuMessageClientOptions {
  appId: string;
  appSecret: string;
}

export type FeishuMessageErrorCode =
  | "client-create-failed"
  | "invalid-credentials"
  | "invalid-response"
  | "send-failed"
  | "send-timeout";

export class FeishuMessageError extends Error {
  readonly code: FeishuMessageErrorCode;

  constructor(code: FeishuMessageErrorCode, message: string) {
    super(message);
    this.name = "FeishuMessageError";
    this.code = code;
  }
}

interface FeishuSdkMessagePayload {
  params: {
    receive_id_type: "chat_id";
  };
  data: {
    receive_id: string;
    msg_type: "text" | "post";
    content: string;
  };
}

interface FeishuSdkMessageClient {
  createMessage(payload: FeishuSdkMessagePayload): Promise<{
    data?: {
      message_id?: string | undefined;
    } | undefined;
  }>;
}

interface FeishuMessageClientDependencies {
  sendTimeoutMs: number;
  createSdkClient(
    options: FeishuMessageClientOptions,
    sendTimeoutMs: number,
  ): FeishuSdkMessageClient;
}

export class FeishuMessageClient implements FeishuMessagePort {
  private readonly sdkClient: FeishuSdkMessageClient;
  private readonly sendTimeoutMs: number;

  constructor(
    options: FeishuMessageClientOptions,
    dependencies: FeishuMessageClientDependencies =
      defaultMessageDependencies,
  ) {
    if (!hasValidCredentials(options)) {
      throw new FeishuMessageError(
        "invalid-credentials",
        "飞书应用凭据格式无效",
      );
    }
    this.sendTimeoutMs = dependencies.sendTimeoutMs;
    try {
      this.sdkClient = dependencies.createSdkClient(
        options,
        dependencies.sendTimeoutMs,
      );
    } catch {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书消息客户端创建失败",
      );
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.sendMessage(chatId, "text", JSON.stringify({ text }));
  }

  async sendPost(chatId: string, markdown: string): Promise<void> {
    await this.sendMessage(
      chatId,
      "post",
      encodeFeishuPostContent(markdown),
    );
  }

  private async sendMessage(
    chatId: string,
    messageType: "text" | "post",
    content: string,
  ): Promise<void> {
    try {
      const response = await withSendTimeout(
        this.sdkClient.createMessage({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            msg_type: messageType,
            content,
          },
        }),
        this.sendTimeoutMs,
      );
      if (
        typeof response?.data?.message_id !== "string"
        || response.data.message_id.trim().length === 0
      ) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书消息响应无效",
        );
      }
    } catch (error) {
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          "飞书消息发送超时",
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        "飞书消息发送失败",
      );
    }
  }
}

function isSdkTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT";
}

export class FeishuEventConnection {
  private stateValue: FeishuConnectionState = "idle";
  private sdkConnection: FeishuSdkConnection | undefined;
  private startPromise: Promise<void> | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(
    private readonly options: FeishuEventConnectionOptions,
    private readonly dependencies: FeishuEventConnectionDependencies =
      defaultDependencies,
  ) {}

  get state(): FeishuConnectionState {
    return this.stateValue;
  }

  start(): Promise<void> {
    if (this.stateValue === "running" || this.stateValue === "reconnecting") {
      return Promise.resolve();
    }
    if (this.stateValue === "stopped") {
      return Promise.reject(new FeishuConnectionError(
        "stopped",
        "飞书长连接已经停止",
      ));
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    const validationError = validateCredentials(this.options);
    if (validationError !== undefined) {
      this.stateValue = "failed";
      return Promise.reject(validationError);
    }

    this.stateValue = "starting";
    const generation = ++this.generation;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      const callbacks: FeishuSdkCallbacks = {
        onReady: () => {
          if (!this.isCurrent(generation) || this.stateValue !== "starting") {
            return;
          }
          this.clearStartupTimer();
          this.rejectStart = undefined;
          this.stateValue = "running";
          resolve();
        },
        onError: () => {
          if (!this.isCurrent(generation)) {
            return;
          }
          if (this.stateValue === "starting") {
            this.failStart(
              generation,
              new FeishuConnectionError(
                "start-failed",
                "飞书长连接启动失败",
              ),
            );
            return;
          }
          if (
            this.stateValue === "running"
            || this.stateValue === "reconnecting"
          ) {
            this.stateValue = "failed";
            this.sdkConnection?.close(true);
            this.sdkConnection = undefined;
            this.options.onFatal(new FeishuConnectionError(
              "start-failed",
              "飞书长连接运行失败",
            ));
          }
        },
        onReconnecting: () => {
          if (
            this.isCurrent(generation)
            && this.stateValue === "running"
          ) {
            this.stateValue = "reconnecting";
            this.notifyLifecycle("onReconnecting");
          }
        },
        onReconnected: () => {
          if (
            this.isCurrent(generation)
            && this.stateValue === "reconnecting"
          ) {
            this.stateValue = "running";
            this.notifyLifecycle("onReconnected");
          }
        },
      };

      try {
        const sdkConnection = this.dependencies.createSdkConnection(
          this.options,
          callbacks,
        );
        this.sdkConnection = sdkConnection;
        sdkConnection.registerMessageHandler((event) => {
          if (
            this.isCurrent(generation)
            && (
              this.stateValue === "running"
              || this.stateValue === "reconnecting"
            )
          ) {
            try {
              this.options.onMessage(decodeFeishuMessageEvent(event));
            } catch (error) {
              if (error instanceof FeishuMessageEventError) {
                try {
                  this.options.onInvalidMessage(error);
                } catch {
                  // Permanent invalid events must not enter a retry loop.
                }
                return;
              }
              throw error;
            }
          }
        });
        this.startupTimer = setTimeout(() => {
          this.failStart(
            generation,
            new FeishuConnectionError(
              "start-timeout",
              "飞书长连接启动超时",
            ),
          );
        }, this.dependencies.startupTimeoutMs);
        void sdkConnection.start().catch(() => {
          this.failStart(
            generation,
            new FeishuConnectionError(
              "start-failed",
              "飞书长连接启动失败",
            ),
          );
        });
      } catch {
        this.failStart(
          generation,
          new FeishuConnectionError(
            "start-failed",
            "飞书长连接启动失败",
          ),
        );
      }
    }).finally(() => {
      if (this.stateValue !== "starting") {
        this.startPromise = undefined;
      }
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stateValue === "stopped") {
      return Promise.resolve();
    }
    const wasStarting = this.stateValue === "starting";
    this.generation += 1;
    this.clearStartupTimer();
    this.stateValue = "stopped";
    this.sdkConnection?.close(wasStarting);
    this.sdkConnection = undefined;
    if (this.rejectStart !== undefined) {
      this.rejectStart(new FeishuConnectionError(
        "stopped",
        "飞书长连接在启动完成前被停止",
      ));
      this.rejectStart = undefined;
    }
    return Promise.resolve();
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.stateValue !== "stopped";
  }

  private failStart(
    generation: number,
    error: FeishuConnectionError,
  ): void {
    if (!this.isCurrent(generation) || this.stateValue !== "starting") {
      return;
    }
    this.clearStartupTimer();
    this.stateValue = "failed";
    this.sdkConnection?.close(true);
    this.sdkConnection = undefined;
    this.rejectStart?.(error);
    this.rejectStart = undefined;
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
  }

  private notifyLifecycle(
    callback: "onReconnecting" | "onReconnected",
  ): void {
    try {
      this.options[callback]?.();
    } catch {
      // Observability callbacks must not interrupt the SDK reader.
    }
  }
}

const redactedSdkLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

const defaultMessageDependencies: FeishuMessageClientDependencies = {
  sendTimeoutMs: 15_000,
  createSdkClient: (options, sendTimeoutMs) => {
    const client = new Client({
      appId: options.appId,
      appSecret: options.appSecret,
      appType: AppType.SelfBuild,
      domain: Domain.Feishu,
      logger: redactedSdkLogger,
      loggerLevel: LoggerLevel.error,
      source: "codexc",
      httpInstance: withHttpTimeout(defaultHttpInstance, sendTimeoutMs),
    });
    return {
      createMessage: (payload) => client.im.v1.message.create(payload),
    };
  },
};

function withHttpTimeout(
  base: HttpInstance,
  timeoutMs: number,
): HttpInstance {
  const options = <D>(
    value?: HttpRequestOptions<D>,
  ): HttpRequestOptions<D> => ({
    ...value,
    timeout: timeoutMs,
  });
  return {
    request: (value) => base.request(options(value)),
    get: (url, value) => base.get(url, options(value)),
    delete: (url, value) => base.delete(url, options(value)),
    head: (url, value) => base.head(url, options(value)),
    options: (url, value) => base.options(url, options(value)),
    post: (url, data, value) => base.post(url, data, options(value)),
    put: (url, data, value) => base.put(url, data, options(value)),
    patch: (url, data, value) => base.patch(url, data, options(value)),
  };
}

const defaultDependencies: FeishuEventConnectionDependencies = {
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  createSdkConnection: (options, callbacks) => {
    const eventDispatcher = new EventDispatcher({
      logger: redactedSdkLogger,
      loggerLevel: LoggerLevel.error,
    });
    const wsClient = new WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      agent: options.webSocketAgent,
      autoReconnect: true,
      domain: Domain.Feishu,
      logger: redactedSdkLogger,
      loggerLevel: LoggerLevel.error,
      source: "codexc",
      handshakeTimeoutMs: 15_000,
      ...callbacks,
    });
    return {
      registerMessageHandler: (handler) => {
        eventDispatcher.register({
          "im.message.receive_v1": handler,
        });
      },
      start: () => wsClient.start({ eventDispatcher }),
      close: (force) => {
        wsClient.close({ force });
      },
    };
  },
};

function validateCredentials(
  options: Pick<FeishuEventConnectionOptions, "appId" | "appSecret">,
): FeishuConnectionError | undefined {
  if (!hasValidCredentials(options)) {
    return new FeishuConnectionError(
      "invalid-credentials",
      "飞书应用凭据格式无效",
    );
  }
  return undefined;
}

function hasValidCredentials(
  options: Pick<FeishuEventConnectionOptions, "appId" | "appSecret">,
): boolean {
  return FEISHU_APP_ID_PATTERN.test(options.appId)
    && options.appSecret.trim().length > 0;
}

async function withSendTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FeishuMessageError(
        "send-timeout",
        "飞书消息发送超时",
      ));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
