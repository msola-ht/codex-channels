import {
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type Logger,
} from "@larksuiteoapi/node-sdk";

import {
  decodeFeishuMessageEvent,
  type FeishuMessageEvent,
} from "./message-event.js";

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
            && (
              this.stateValue === "running"
              || this.stateValue === "reconnecting"
            )
          ) {
            this.stateValue = "reconnecting";
          }
        },
        onReconnected: () => {
          if (
            this.isCurrent(generation)
            && (
              this.stateValue === "running"
              || this.stateValue === "reconnecting"
            )
          ) {
            this.stateValue = "running";
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
            this.options.onMessage(decodeFeishuMessageEvent(event));
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
}

const redactedSdkLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

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
  if (
    !FEISHU_APP_ID_PATTERN.test(options.appId)
    || options.appSecret.trim().length === 0
  ) {
    return new FeishuConnectionError(
      "invalid-credentials",
      "飞书应用凭据格式无效",
    );
  }
  return undefined;
}
