import {
  AppType,
  Client,
  Domain,
  LoggerLevel,
  defaultHttpInstance,
  type HttpInstance,
  type HttpRequestOptions,
  type Logger,
} from "@larksuiteoapi/node-sdk";

import type { FeishuCardDocument } from "./approval-card.js";
import type { FeishuFileResourcePort } from "./file-input.js";
import {
  isSafeFeishuResourceIdentifier,
  type FeishuImageResourcePort,
} from "./media.js";
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
    msg_type: "text" | "post" | "interactive" | "file" | "image";
    content: string;
  };
}

interface FeishuSdkMessageClient {
  createMessage(payload: FeishuSdkMessagePayload): Promise<{
    data?: {
      message_id?: string | undefined;
    } | undefined;
  }>;
  createFile?(payload: {
    data: {
      file_type: "stream";
      file_name: string;
      file: Buffer;
    };
  }): Promise<{
    file_key?: string | undefined;
    data?: {
      file_key?: string | undefined;
    } | undefined;
  } | null>;
  createImage?(payload: {
    data: {
      image_type: "message";
      image: Buffer;
    };
  }): Promise<{
    image_key?: string | undefined;
    data?: {
      image_key?: string | undefined;
    } | undefined;
  } | null>;
  replyMessage?(payload: {
    path: {
      message_id: string;
    };
    data: {
      msg_type: "post" | "interactive";
      content: string;
      reply_in_thread: false;
    };
  }): Promise<{
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
      card: {
        type: "card_json";
        data: string;
      };
      sequence: number;
      uuid: string;
    };
  }): Promise<{
    code?: number | undefined;
  }>;
  downloadResource(payload: {
    params: {
      type: "image" | "file";
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
  FeishuFileResourcePort,
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
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书消息客户端创建失败",
      );
    }
  }

  async sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.sendMessage(chatId, "text", JSON.stringify({ text }), signal);
  }

  async sendPost(chatId: string, markdown: string, signal?: AbortSignal): Promise<void> {
    await this.sendMessage(
      chatId,
      "post",
      encodeFeishuPostContent(markdown), signal,
    );
  }

  async sendFile(
    chatId: string,
    fileName: string,
    file: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !this.sdkClient.createFile
      || file.length === 0
      || file.length > 30 * 1_024 * 1_024
      || Buffer.byteLength(fileName, "utf8") > 255
      || fileName.length === 0
      || fileName.includes("/")
      || fileName.includes("\\")
    ) {
      throw new FeishuMessageError(
        "invalid-response",
        "飞书文件发送参数无效",
      );
    }
    try {
      const response = await withTimeout(
        this.sdkClient.createFile({
          data: {
            file_type: "stream",
            file_name: fileName,
            file,
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          "飞书文件上传超时",
        ), signal,
      );
      const fileKey = response?.file_key ?? response?.data?.file_key;
      if (
        typeof fileKey !== "string"
        || !isSafeFeishuResourceIdentifier(fileKey)
      ) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书文件上传响应无效",
        );
      }
      await this.sendMessage(
        chatId,
        "file",
        JSON.stringify({ file_key: fileKey }), signal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          "飞书文件上传超时",
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        "飞书文件发送失败",
      );
    }
  }

  async sendImage(chatId: string, image: Buffer, signal?: AbortSignal): Promise<void> {
    if (
      !this.sdkClient.createImage
      || image.length === 0
      || image.length > 10 * 1_024 * 1_024
    ) {
      throw new FeishuMessageError(
        "invalid-response",
        "飞书图片发送参数无效",
      );
    }
    try {
      const response = await withTimeout(
        this.sdkClient.createImage({
          data: {
            image_type: "message",
            image,
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          "飞书图片上传超时",
        ), signal,
      );
      const imageKey = response?.image_key ?? response?.data?.image_key;
      if (
        typeof imageKey !== "string"
        || !isSafeFeishuResourceIdentifier(imageKey)
      ) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书图片上传响应无效",
        );
      }
      await this.sendMessage(
        chatId,
        "image",
        JSON.stringify({ image_key: imageKey }), signal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          "飞书图片上传超时",
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        "飞书图片发送失败",
      );
    }
  }

  async replyPost(messageId: string, markdown: string, signal?: AbortSignal): Promise<void> {
    await this.replyMessage(
      messageId,
      "post",
      encodeFeishuPostContent(markdown), signal,
    );
  }

  async sendMarkdownCard(chatId: string, markdown: string, signal?: AbortSignal): Promise<string> {
    const cardId = await this.createMarkdownCard(markdown, signal);
    return this.sendMessage(
      chatId,
      "interactive",
      JSON.stringify({
        type: "card",
        data: {
          card_id: cardId,
        },
      }), signal,
    );
  }

  async replyMarkdownCard(
    messageId: string,
    markdown: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cardId = await this.createMarkdownCard(markdown, signal);
    return this.replyMessage(
      messageId,
      "interactive",
      JSON.stringify({
        type: "card",
        data: {
          card_id: cardId,
        },
      }), signal,
    );
  }

  async createStreamingCard(
    chatId: string,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<{ cardId: string; messageId: string }> {
    const cardId = await this.createStreamingCardResource(initialText, signal);
    const messageId = await this.sendMessage(
      chatId,
      "interactive",
      JSON.stringify({
        type: "card",
        data: {
          card_id: cardId,
        },
      }), signal,
    );
    return { cardId, messageId };
  }

  async createStreamingReplyCard(
    messageId: string,
    initialText: string,
    signal?: AbortSignal,
  ): Promise<{ cardId: string; messageId: string }> {
    const cardId = await this.createStreamingCardResource(initialText, signal);
    const replyMessageId = await this.replyMessage(
      messageId,
      "interactive",
      JSON.stringify({
        type: "card",
        data: {
          card_id: cardId,
        },
      }), signal,
    );
    return { cardId, messageId: replyMessageId };
  }

  async updateStreamingCard(
    cardId: string,
    content: string,
    sequence: number,
    signal?: AbortSignal,
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
      "飞书流式卡片更新", signal,
    );
  }

  async finishStreamingCard(
    cardId: string,
    sequence: number,
    summary: string,
    footer?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.sdkClient.finishStreamingCard) {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书流式卡片客户端未初始化",
      );
    }
    const safeMarkdown = sanitizeFeishuMarkdown(summary);
    const safeFooter = footer === undefined
      ? undefined
      : sanitizeFeishuMarkdown(footer);
    await this.runStreamingOperation(
      () => this.sdkClient.finishStreamingCard!({
        path: {
          card_id: cardId,
        },
        data: {
          card: {
            type: "card_json",
            data: JSON.stringify({
              schema: "2.0",
              config: {
                streaming_mode: false,
                summary: {
                  content: streamingSummary(safeMarkdown),
                },
              },
              body: {
                elements: [
                  {
                    tag: "markdown",
                    element_id: "codexc_stream",
                    content: safeMarkdown || "...",
                  },
                  ...(safeFooter === undefined
                    ? []
                    : [
                        { tag: "hr" },
                        {
                          tag: "markdown",
                          content: safeFooter || "...",
                        },
                      ]),
                ],
              },
            }),
          },
          sequence,
          uuid: `f_${cardId}_${sequence}`,
        },
      }),
      "飞书流式卡片结束", signal,
    );
  }

  async sendCard(
    chatId: string,
    card: FeishuCardDocument,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.sendMessage(
      chatId,
      "interactive",
      JSON.stringify(card), signal,
    );
  }

  async updateCard(
    messageId: string,
    card: FeishuCardDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.updateMessage(messageId, JSON.stringify(card), signal);
  }

  private async updateMessage(
    messageId: string,
    content: string,
    signal?: AbortSignal,
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
        ), signal,
      );
      if (response.code !== undefined && response.code !== 0) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书消息更新响应无效",
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
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
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const response = await withTimeout(
        operation(),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          `${label}超时`,
        ), signal,
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
      if (isAbortError(error)) {
        throw error;
      }
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
    return this.downloadMessageResource(
      messageId,
      imageKey,
      "image",
      "图片",
    );
  }

  async downloadFile(
    messageId: string,
    fileKey: string,
  ): Promise<{
    stream: import("node:stream").Readable;
    contentLength?: number;
  }> {
    return this.downloadMessageResource(
      messageId,
      fileKey,
      "file",
      "文件",
    );
  }

  async downloadAudio(
    messageId: string,
    fileKey: string,
  ): Promise<{
    stream: import("node:stream").Readable;
    contentLength?: number;
  }> {
    return this.downloadMessageResource(
      messageId,
      fileKey,
      "file",
      "音频",
    );
  }

  private async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    label: "图片" | "文件" | "音频",
  ): Promise<{
    stream: import("node:stream").Readable;
    contentLength?: number;
  }> {
    if (
      !isSafeFeishuResourceIdentifier(messageId)
      || !isSafeFeishuResourceIdentifier(fileKey)
    ) {
      throw new FeishuMessageError(
        "invalid-response",
        `飞书${label}资源标识无效`,
      );
    }
    try {
      const response = await withTimeout(
        this.sdkClient.downloadResource({
          params: {
            type,
          },
          path: {
            message_id: messageId,
            file_key: fileKey,
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "download-timeout",
          `飞书${label}下载超时`,
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
          `飞书${label}下载超时`,
        );
      }
      throw new FeishuMessageError(
        "download-failed",
        `飞书${label}下载失败`,
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

  private async createStreamingCardResource(
    initialText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.sdkClient.createStreamingCard) {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书流式卡片客户端未初始化",
      );
    }
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
        ), signal,
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
      return candidate;
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
  }

  private async createMarkdownCard(markdown: string, signal?: AbortSignal): Promise<string> {
    if (!this.sdkClient.createStreamingCard) {
      throw new FeishuMessageError(
        "card-create-failed",
        "飞书静态卡片创建失败",
      );
    }
    const safeMarkdown = sanitizeFeishuMarkdown(markdown);
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
        ), signal,
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
      return candidate;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new FeishuMessageError(
        "card-create-failed",
        "飞书静态卡片创建失败",
      );
    }
  }

  private async replyMessage(
    messageId: string,
    messageType: "post" | "interactive",
    content: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!isSafeFeishuResourceIdentifier(messageId)) {
      throw new FeishuMessageError(
        "invalid-response",
        "飞书回复消息标识无效",
      );
    }
    if (!this.sdkClient.replyMessage) {
      throw new FeishuMessageError(
        "client-create-failed",
        "飞书回复消息客户端未初始化",
      );
    }
    try {
      const response = await withTimeout(
        this.sdkClient.replyMessage({
          path: {
            message_id: messageId,
          },
          data: {
            msg_type: messageType,
            content,
            reply_in_thread: false,
          },
        }),
        this.sendTimeoutMs,
        new FeishuMessageError(
          "send-timeout",
          "飞书回复消息发送超时",
        ), signal,
      );
      if (
        typeof response?.data?.message_id !== "string"
        || response.data.message_id.trim().length === 0
      ) {
        throw new FeishuMessageError(
          "invalid-response",
          "飞书回复消息响应无效",
        );
      }
      return response.data.message_id;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (error instanceof FeishuMessageError) {
        throw error;
      }
      if (isSdkTimeout(error)) {
        throw new FeishuMessageError(
          "send-timeout",
          "飞书回复消息发送超时",
        );
      }
      throw new FeishuMessageError(
        "send-failed",
        "飞书回复消息发送失败",
      );
    }
  }

  private async sendMessage(
    chatId: string,
    messageType: "text" | "post" | "interactive" | "file" | "image",
    content: string,
    signal?: AbortSignal,
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
        ), signal,
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
      if (isAbortError(error)) {
        throw error;
      }
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
      createFile: (payload) => client.im.v1.file.create(payload),
      createImage: (payload) => client.im.v1.image.create(payload),
      replyMessage: (payload) => client.im.v1.message.reply(payload),
      patchMessage: (payload) => client.im.v1.message.patch(payload),
      getMessage: (payload) => client.im.v1.message.get(payload),
      createStreamingCard: (payload) =>
        client.cardkit.v1.card.create(payload),
      updateStreamingCard: (payload) =>
        client.cardkit.v1.cardElement.content(payload),
      finishStreamingCard: (payload) =>
        client.cardkit.v1.card.update(payload),
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

function hasValidCredentials(
  options: Pick<FeishuMessageClientOptions, "appId" | "appSecret">,
): boolean {
  return FEISHU_APP_ID_PATTERN.test(options.appId)
    && options.appSecret.trim().length > 0;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
  signal?: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
    }, timeoutMs);
    timer.unref();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(createAbortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function createAbortError(): Error {
  const error = new Error("飞书输出操作已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
