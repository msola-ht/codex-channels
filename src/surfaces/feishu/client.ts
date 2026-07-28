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
import {
  decodeFeishuCardAction,
  FeishuCardActionError,
  type FeishuCardAction,
} from "./card-action.js";
import type { FeishuCardDocument } from "./approval-card.js";
import {
  isSafeFeishuResourceIdentifier,
  type FeishuImageResourcePort,
} from "./media.js";
import {
  decodeFeishuMenuEvent,
  FeishuMenuEventError,
  type FeishuMenuEvent,
} from "./menu-event.js";
import {
  encodeFeishuPostContent,
  sanitizeFeishuMarkdown,
} from "./message-content.js";
import { extractFeishuQuotedText } from "./inbound-content.js";
import type { FeishuMessagePort } from "./outbox.js";
import {
  abortableSleep,
  FeishuOAuthHttpClient,
  type FeishuOAuthApi,
} from "./oauth-device-flow.js";

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
  onCardAction?(event: FeishuCardAction): void;
  onInvalidCardAction?(error: FeishuCardActionError): void;
  onMenuEvent?(event: FeishuMenuEvent): void;
  onInvalidMenuEvent?(error: FeishuMenuEventError): void;
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
  registerCardActionHandler(handler: (event: unknown) => void): void;
  registerMenuEventHandler(handler: (event: unknown) => void): void;
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
  httpAgent?: unknown;
  disableEnvironmentProxy?: boolean;
}

export interface FeishuQuotedMessagePort {
  readQuotedText(messageId: string): Promise<string | undefined>;
}

export function createFeishuOAuthApi(
  options: FeishuMessageClientOptions,
  accountsHttpAgent?: unknown,
): FeishuOAuthApi {
  if (!hasValidCredentials(options)) {
    throw new FeishuMessageError(
      "invalid-credentials",
      "飞书应用凭据格式无效",
    );
  }
  const client = createSdkClient(options, 15_000);
  const openApiHttp = applyFeishuHttpPolicy(
    defaultHttpInstance,
    15_000,
    options.httpAgent,
    options.disableEnvironmentProxy,
  );
  const accountsHttp = applyFeishuHttpPolicy(
    defaultHttpInstance,
    15_000,
    accountsHttpAgent,
    options.disableEnvironmentProxy,
  );
  return new FeishuOAuthHttpClient(
    options.appId,
    options.appSecret,
    {
      fetch: createFeishuOAuthFetch(openApiHttp, accountsHttp),
      sleep: abortableSleep,
      listGrantedUserScopes: (signal) => client.request({
        method: "GET",
        url: `/open-apis/application/v6/applications/${options.appId}`,
        signal,
        params: {
          lang: "zh_cn",
        },
      }),
    },
  );
}

export type FeishuMessageErrorCode =
  | "card-create-failed"
  | "client-create-failed"
  | "invalid-credentials"
  | "invalid-response"
  | "download-failed"
  | "download-timeout"
  | "read-failed"
  | "read-timeout"
  | "rate-limited"
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
    msg_type: "text" | "post" | "interactive";
    content: string;
  };
}

interface FeishuSdkMessageClient {
  createMessage(payload: FeishuSdkMessagePayload): Promise<{
    data?: {
      message_id?: string | undefined;
    } | undefined;
  }>;
  patchMessage(payload: {
    path: {
      message_id: string;
    };
    data: {
      content: string;
    };
  }): Promise<{
    code?: number | undefined;
  }>;
  getMessage?(payload: {
    params: {
      user_id_type: "open_id";
      card_msg_content_type: "raw_card_content";
    };
    path: { message_id: string };
  }): Promise<{
    code?: number | undefined;
    data?: {
      items?: Array<{
        msg_type?: string | undefined;
        body?: { content?: string | undefined } | undefined;
      }> | undefined;
    } | undefined;
  }>;
  createStreamingCard?(payload: {
    data: {
      type: "card_json";
      data: string;
    };
  }): Promise<{
    code?: number | undefined;
    data?: {
      card_id?: string | undefined;
    } | undefined;
  }>;
  updateStreamingCard?(payload: {
    path: {
      card_id: string;
      element_id: string;
    };
    data: {
      content: string;
      sequence: number;
      uuid: string;
    };
  }): Promise<{
    code?: number | undefined;
  }>;
  finishStreamingCard?(payload: {
    path: {
      card_id: string;
    };
    data: {
      settings: string;
      sequence: number;
      uuid: string;
    };
  }): Promise<{
    code?: number | undefined;
  }>;
  downloadResource(payload: {
    params: {
      type: "image";
    };
    path: {
      message_id: string;
      file_key: string;
    };
  }): Promise<{
    getReadableStream(): import("node:stream").Readable;
    headers: unknown;
  }>;
}

interface FeishuMessageClientDependencies {
  sendTimeoutMs: number;
  createSdkClient(
    options: FeishuMessageClientOptions,
    sendTimeoutMs: number,
  ): FeishuSdkMessageClient;
}

export class FeishuMessageClient implements
  FeishuMessagePort,
  FeishuImageResourcePort,
  FeishuQuotedMessagePort
{
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

  async sendMarkdownCard(chatId: string, markdown: string): Promise<void> {
    if (!this.sdkClient.createStreamingCard) {
      throw new FeishuMessageError(
        "card-create-failed",
        "飞书静态卡片创建失败",
      );
    }
    const safeMarkdown = sanitizeFeishuMarkdown(markdown);
    let cardId: string;
    try {
      const response = await withTimeout(
        this.sdkClient.createStreamingCard({
          data: {
            type: "card_json",
            data: JSON.stringify({
              schema: "2.0",
              config: {
                summary: {
                  content: streamingSummary(safeMarkdown),
                },
              },
              body: {
                elements: [{
                  tag: "markdown",
                  content: safeMarkdown,
                }],
              },
            }),
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          "飞书静态卡片创建超时",
        ),
      );
      const candidate = response.data?.card_id;
      if (
        (response.code !== undefined && response.code !== 0)
        || typeof candidate !== "string"
        || candidate.length === 0
        || candidate.length > 20
      ) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书静态卡片创建响应无效",
        );
      }
      cardId = candidate;
    } catch {
      throw new FeishuMessageError(
        "card-create-failed",
        "飞书静态卡片创建失败",
      );
    }
    await this.sendMessage(
      chatId,
      "interactive",
      JSON.stringify({
        type: "card",
        data: {
          card_id: cardId,
        },
      }),
    );
  }

  async createStreamingCard(
    chatId: string,
    initialText: string,
  ): Promise<{ cardId: string; messageId: string }> {
    if (!this.sdkClient.createStreamingCard) {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书流式卡片客户端未初始化",
      );
    }
    let cardId: string;
    try {
      const response = await withTimeout(
        this.sdkClient.createStreamingCard({
          data: {
            type: "card_json",
            data: JSON.stringify({
              schema: "2.0",
              config: {
                streaming_mode: true,
                summary: {
                  content: "生成中",
                },
                streaming_config: {
                  print_frequency_ms: {
                    default: 70,
                  },
                  print_step: {
                    default: 1,
                  },
                  print_strategy: "fast",
                },
              },
              body: {
                elements: [{
                  tag: "markdown",
                  element_id: "codexc_stream",
                  content: sanitizeFeishuMarkdown(initialText || "..."),
                }],
              },
            }),
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          "飞书流式卡片创建超时",
        ),
      );
      const candidate = response.data?.card_id;
      if (
        (response.code !== undefined && response.code !== 0)
        || typeof candidate !== "string"
        || candidate.length === 0
        || candidate.length > 20
      ) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书流式卡片创建响应无效",
        );
      }
      cardId = candidate;
    } catch (error) {
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          "飞书流式卡片创建超时",
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        "飞书流式卡片创建失败",
      );
    }
    const messageId = await this.sendMessage(
      chatId,
      "interactive",
      JSON.stringify({
        type: "card",
        data: {
          card_id: cardId,
        },
      }),
    );
    return { cardId, messageId };
  }

  async updateStreamingCard(
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    if (!this.sdkClient.updateStreamingCard) {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书流式卡片客户端未初始化",
      );
    }
    await this.runStreamingOperation(
      () => this.sdkClient.updateStreamingCard!({
        path: {
          card_id: cardId,
          element_id: "codexc_stream",
        },
        data: {
          content: sanitizeFeishuMarkdown(content || "..."),
          sequence,
          uuid: `c_${cardId}_${sequence}`,
        },
      }),
      "飞书流式卡片更新",
    );
  }

  async finishStreamingCard(
    cardId: string,
    sequence: number,
    summary: string,
  ): Promise<void> {
    if (!this.sdkClient.finishStreamingCard) {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书流式卡片客户端未初始化",
      );
    }
    await this.runStreamingOperation(
      () => this.sdkClient.finishStreamingCard!({
        path: {
          card_id: cardId,
        },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: {
                content: streamingSummary(sanitizeFeishuMarkdown(summary)),
              },
            },
          }),
          sequence,
          uuid: `s_${cardId}_${sequence}`,
        },
      }),
      "飞书流式卡片结束",
    );
  }

  async sendCard(
    chatId: string,
    card: FeishuCardDocument,
  ): Promise<string> {
    return this.sendMessage(
      chatId,
      "interactive",
      JSON.stringify(card),
    );
  }

  async updateCard(
    messageId: string,
    card: FeishuCardDocument,
  ): Promise<void> {
    await this.updateMessage(messageId, JSON.stringify(card));
  }

  private async updateMessage(
    messageId: string,
    content: string,
  ): Promise<void> {
    try {
      const response = await withTimeout(
        this.sdkClient.patchMessage({
          path: {
            message_id: messageId,
          },
          data: {
            content,
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          "飞书消息更新超时",
        ),
      );
      if (response.code !== undefined && response.code !== 0) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书消息更新响应无效",
        );
      }
    } catch (error) {
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          "飞书消息更新超时",
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        "飞书消息更新失败",
      );
    }
  }

  private async runStreamingOperation(
    operation: () => Promise<{ code?: number | undefined }>,
    label: string,
  ): Promise<void> {
    try {
      const response = await withTimeout(
        operation(),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          `${label}超时`,
        ),
      );
      if (response.code !== undefined && response.code !== 0) {
        if (isFeishuRateLimitCode(response.code)) {
          throw new FeishuMessageError(
            "rate-limited",
            `${label}请求受限`,
          );
        }
        throw new FeishuMessageError(
          "invalid-response",
          `${label}响应无效`,
        );
      }
    } catch (error) {
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isFeishuRateLimitError(error)) {
        throw new FeishuMessageError(
          "rate-limited",
          `${label}请求受限`,
        );
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          `${label}超时`,
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        `${label}失败`,
      );
    }
  }

  async downloadImage(
    messageId: string,
    imageKey: string,
  ): Promise<{
    stream: import("node:stream").Readable;
    contentLength?: number;
  }> {
    if (
      !isSafeFeishuResourceIdentifier(messageId)
      || !isSafeFeishuResourceIdentifier(imageKey)
    ) {
      throw new FeishuMessageError(
        "invalid-response",
        "飞书图片资源标识无效",
      );
    }
    try {
      const response = await withTimeout(
        this.sdkClient.downloadResource({
          params: {
            type: "image",
          },
          path: {
            message_id: messageId,
            file_key: imageKey,
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "download-timeout",
          "飞书图片下载超时",
        ),
      );
      const stream = response.getReadableStream();
      const contentLength = readContentLength(response.headers);
      return {
        stream,
        ...(contentLength === undefined ? {} : { contentLength }),
      };
    } catch (error) {
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "download-timeout",
          "飞书图片下载超时",
        );
      }
      throw new FeishuMessageError(
        "download-failed",
        "飞书图片下载失败",
      );
    }
  }

  async readQuotedText(messageId: string): Promise<string | undefined> {
    if (!isSafeFeishuResourceIdentifier(messageId)) {
      throw new FeishuMessageError(
        "invalid-response",
        "飞书引用消息标识无效",
      );
    }
    if (!this.sdkClient.getMessage) {
      return undefined;
    }
    try {
      const response = await withTimeout(
        this.sdkClient.getMessage({
          params: {
            user_id_type: "open_id",
            card_msg_content_type: "raw_card_content",
          },
          path: { message_id: messageId },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "read-timeout",
          "飞书引用消息读取超时",
        ),
      );
      if (response.code !== undefined && response.code !== 0) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书引用消息响应无效",
        );
      }
      const items = response.data?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return undefined;
      }
      if (items.length > 100) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书引用消息响应无效",
        );
      }
      const item = items[0];
      const messageType = item?.msg_type;
      const content = item?.body?.content;
      if (
        typeof messageType !== "string"
        || typeof content !== "string"
        || Buffer.byteLength(content, "utf8") > 150 * 1_024
      ) {
        return undefined;
      }
      return extractFeishuQuotedText(messageType, content);
    } catch (error) {
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "read-timeout",
          "飞书引用消息读取超时",
        );
      }
      throw new FeishuMessageError(
        "read-failed",
        "飞书引用消息读取失败",
      );
    }
  }

  private async sendMessage(
    chatId: string,
    messageType: "text" | "post" | "interactive",
    content: string,
  ): Promise<string> {
    try {
      const response = await withTimeout(
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
        new FeishuMessageError(
          "send-timeout",
          "飞书消息发送超时",
        ),
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
      return response.data.message_id;
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

function isFeishuRateLimitCode(code: number): boolean {
  return code === 99991400;
}

function isFeishuRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const value = error as {
    status?: unknown;
    code?: unknown;
    data?: { code?: unknown } | undefined;
    response?: {
      status?: unknown;
      data?: { code?: unknown } | undefined;
    } | undefined;
  };
  if (value.status === 429 || value.response?.status === 429) {
    return true;
  }
  const code =
    value.response?.data?.code
    ?? value.data?.code
    ?? value.code;
  return typeof code === "number" && isFeishuRateLimitCode(code);
}

function isSdkTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT";
}

function readContentLength(headers: unknown): number | undefined {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    return undefined;
  }
  const value = (headers as Record<string, unknown>)["content-length"];
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : undefined;
  return parsed !== undefined
    && Number.isSafeInteger(parsed)
    && parsed >= 0
    ? parsed
    : undefined;
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
        sdkConnection.registerCardActionHandler((event) => {
          if (
            this.isCurrent(generation)
            && (
              this.stateValue === "running"
              || this.stateValue === "reconnecting"
            )
          ) {
            try {
              this.options.onCardAction?.(decodeFeishuCardAction(event));
            } catch (error) {
              if (error instanceof FeishuCardActionError) {
                try {
                  this.options.onInvalidCardAction?.(error);
                } catch {
                  // Permanent invalid actions must not enter a retry loop.
                }
                return;
              }
              throw error;
            }
          }
        });
        sdkConnection.registerMenuEventHandler((event) => {
          if (
            this.isCurrent(generation)
            && (
              this.stateValue === "running"
              || this.stateValue === "reconnecting"
            )
          ) {
            try {
              this.options.onMenuEvent?.(decodeFeishuMenuEvent(event));
            } catch (error) {
              if (error instanceof FeishuMenuEventError) {
                try {
                  this.options.onInvalidMenuEvent?.(error);
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
    const client = createSdkClient(options, sendTimeoutMs);
    return {
      createMessage: (payload) => client.im.v1.message.create(payload),
      patchMessage: (payload) => client.im.v1.message.patch(payload),
      getMessage: (payload) => client.im.v1.message.get(payload),
      createStreamingCard: (payload) =>
        client.cardkit.v1.card.create(payload),
      updateStreamingCard: (payload) =>
        client.cardkit.v1.cardElement.content(payload),
      finishStreamingCard: (payload) =>
        client.cardkit.v1.card.settings(payload),
      downloadResource: (payload) => client.im.v1.messageResource.get(payload),
    };
  },
};

function streamingSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "无内容";
  }
  if (normalized.length <= 50) {
    return normalized;
  }
  let summary = "";
  for (const character of normalized) {
    if (summary.length + character.length > 49) {
      break;
    }
    summary += character;
  }
  return `${summary}…`;
}

function createSdkClient(
  options: FeishuMessageClientOptions,
  timeoutMs: number,
): Client {
  return new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    appType: AppType.SelfBuild,
    domain: Domain.Feishu,
    logger: redactedSdkLogger,
    loggerLevel: LoggerLevel.error,
    source: "codexc",
    httpInstance: applyFeishuHttpPolicy(
      defaultHttpInstance,
      timeoutMs,
      options.httpAgent,
      options.disableEnvironmentProxy,
    ),
  });
}

export function applyFeishuHttpPolicy(
  base: HttpInstance,
  timeoutMs: number,
  agent?: unknown,
  disableEnvironmentProxy = false,
): HttpInstance {
  const options = <D>(
    value?: HttpRequestOptions<D>,
  ): HttpRequestOptions<D> => ({
    ...value,
    timeout: timeoutMs,
    ...(agent
      ? {
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
        }
      : disableEnvironmentProxy
      ? { proxy: false }
      : {}),
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

function createFeishuOAuthFetch(
  openApiHttp: HttpInstance,
  accountsHttp: HttpInstance,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const http = new URL(url).hostname === "accounts.feishu.cn"
      ? accountsHttp
      : openApiHttp;
    try {
      const body: unknown = await http.request({
        url,
        method: init?.method,
        headers: init?.headers
          ? Object.fromEntries(new Headers(init.headers).entries())
          : undefined,
        data: init?.body,
        signal: init?.signal,
      } as HttpRequestOptions<BodyInit> & { signal?: AbortSignal | null });
      return jsonFetchResponse(body, 200);
    } catch (error) {
      const response = optionalHttpErrorResponse(error);
      if (response) {
        return jsonFetchResponse(response.data, response.status);
      }
      throw error;
    }
  };
}

function jsonFetchResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function optionalHttpErrorResponse(error: unknown): {
  status: number;
  data: unknown;
} | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const response = (error as {
    response?: { status?: unknown; data?: unknown };
  }).response;
  return typeof response?.status === "number"
    && Number.isInteger(response.status)
    && response.status >= 400
    && response.status <= 599
    ? { status: response.status, data: response.data }
    : undefined;
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
      registerCardActionHandler: (handler) => {
        eventDispatcher.register({
          "card.action.trigger": handler,
        });
      },
      registerMenuEventHandler: (handler) => {
        eventDispatcher.register({
          "application.bot.menu_v6": handler,
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

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
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
