import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  validateWeixinAccountId,
  validateWeixinActorId,
  validateWeixinBaseUrl,
} from "./credential-store.js";

export type WeixinProtocolErrorCode =
  | "aborted"
  | "api-error"
  | "http-error"
  | "invalid-input"
  | "invalid-response"
  | "network-error"
  | "timeout";

export class WeixinProtocolError extends Error {
  constructor(
    readonly code: WeixinProtocolErrorCode,
    message: string,
    readonly status?: number,
    readonly returnCode?: number,
  ) {
    super(message);
    this.name = "WeixinProtocolError";
  }
}

export type WeixinIgnoredMessageReason =
  | "missing-context"
  | "unsupported-content"
  | "unsupported-message-type"
  | "unfinished"
  | "wrong-recipient";

export interface WeixinImageReference {
  fullUrl?: string;
  encryptedQueryParam?: string;
  imageAesKey?: string;
  mediaAesKey?: string;
}

export interface WeixinFileReference {
  fileName: string;
  fullUrl?: string;
  encryptedQueryParam?: string;
  mediaAesKey?: string;
  declaredLength?: string;
  declaredMd5?: string;
}

export type WeixinInboundMessage =
  | {
      kind: "text";
      messageId: string;
      actorId: string;
      conversationId: string;
      contextToken: string;
      text: string;
      quotedText?: string;
      quotedMessageId?: string;
      createdAt?: number;
    }
  | {
      kind: "image";
      messageId: string;
      actorId: string;
      conversationId: string;
      contextToken: string;
      text?: string;
      quotedText?: string;
      quotedMessageId?: string;
      images: readonly WeixinImageReference[];
      createdAt?: number;
    }
  | {
      kind: "file";
      messageId: string;
      actorId: string;
      conversationId: string;
      contextToken: string;
      text?: string;
      quotedText?: string;
      quotedMessageId?: string;
      file: WeixinFileReference;
      createdAt?: number;
    }
  | {
      kind: "ignored";
      messageId: string;
      reason: WeixinIgnoredMessageReason;
    };

export interface WeixinUpdatesBatch {
  cursor: string;
  messages: readonly WeixinInboundMessage[];
  suggestedTimeoutMs?: number;
}

export interface WeixinProtocolClient {
  getUpdates(
    cursor: string,
    signal?: AbortSignal,
  ): Promise<WeixinUpdatesBatch>;
  sendText(
    input: {
      actorId: string;
      contextToken: string;
      text: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WeixinImageSendProtocolClient {
  sendImage(
    input: {
      actorId: string;
      contextToken: string;
      image: Buffer;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export type WeixinTypingStatus = "cancel" | "typing";

export interface WeixinTypingProtocolClient {
  getTypingTicket(
    input: {
      actorId: string;
      contextToken: string;
    },
    signal?: AbortSignal,
  ): Promise<string>;
  setTyping(
    input: {
      actorId: string;
      typingTicket: string;
      status: WeixinTypingStatus;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export type WeixinRuntimeProtocolClient =
  & WeixinProtocolClient
  & WeixinImageSendProtocolClient
  & WeixinTypingProtocolClient;

export interface CreateWeixinProtocolClientOptions {
  accountId: string;
  baseUrl: string;
  botToken: string;
  fetchImpl?: typeof fetch;
  getUpdatesTimeoutMs?: number;
  sendTimeoutMs?: number;
  imageUploadTimeoutMs?: number;
  typingTimeoutMs?: number;
  randomBytesImpl?: typeof randomBytes;
  nowImpl?: () => number;
}

const appClientVersion = (2 << 16) | (4 << 8) | 6;
const maximumCursorLength = 65_536;
const maximumGetUpdatesResponseBytes = 1_048_576;
const maximumSendResponseBytes = 65_536;
const maximumTextLength = 4_000;
const maximumInboundImages = 4;
const maximumImageBytes = 10 * 1024 * 1024;
const maximumImageParameterLength = 65_536;
const maximumImageUploadAttempts = 3;
const weixinCdnOrigin = "https://novac2c.cdn.weixin.qq.com";
const weixinCdnUploadPath = "/c2c/upload";

export function createWeixinProtocolClient(
  options: CreateWeixinProtocolClientOptions,
): WeixinRuntimeProtocolClient {
  const accountId = validateAccountInput(options.accountId);
  const baseUrl = validateBaseUrlInput(options.baseUrl);
  const botToken = requiredInputString(
    options.botToken,
    "微信 Bot Token 无效",
    16_384,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const getUpdatesTimeoutMs = positiveTimeout(
    options.getUpdatesTimeoutMs ?? 40_000,
    "微信长轮询超时时间无效",
  );
  const sendTimeoutMs = positiveTimeout(
    options.sendTimeoutMs ?? 15_000,
    "微信发送超时时间无效",
  );
  const imageUploadTimeoutMs = positiveTimeout(
    options.imageUploadTimeoutMs ?? 30_000,
    "微信图片上传超时时间无效",
  );
  const typingTimeoutMs = positiveTimeout(
    options.typingTimeoutMs ?? 10_000,
    "微信输入状态请求超时时间无效",
  );
  const randomBytesImpl = options.randomBytesImpl ?? randomBytes;
  const nowImpl = options.nowImpl ?? Date.now;

  return {
    async getUpdates(cursor, signal) {
      const safeCursor = optionalInputString(
        cursor,
        "微信长轮询游标无效",
        maximumCursorLength,
      );
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "getupdates",
        body: {
          get_updates_buf: safeCursor,
          base_info: baseInfo(),
        },
        timeoutMs: getUpdatesTimeoutMs,
        maximumResponseBytes: maximumGetUpdatesResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信长轮询",
      });
      return parseUpdatesResponse(raw, accountId);
    },

    async sendText(input, signal) {
      const actorId = validateActorInput(input.actorId);
      const contextToken = requiredInputString(
        input.contextToken,
        "微信回复上下文无效",
        65_536,
      );
      const text = requiredInputString(
        input.text,
        "微信回复文本无效",
        maximumTextLength,
      );
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "sendmessage",
        body: {
          msg: {
            from_user_id: "",
            to_user_id: actorId,
            client_id: createClientId(randomBytesImpl, nowImpl),
            message_type: 2,
            message_state: 2,
            item_list: [{
              type: 1,
              text_item: { text },
            }],
            context_token: contextToken,
          },
          base_info: baseInfo(),
        },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信发送",
      });
      parseSendResponse(raw);
    },

    async sendImage(input, signal) {
      const actorId = validateActorInput(input.actorId);
      const contextToken = requiredInputString(
        input.contextToken,
        "微信图片回复上下文无效",
        maximumImageParameterLength,
      );
      const image = validateOutboundImage(input.image);
      const aesKey = exactRandomBytes(
        randomBytesImpl,
        16,
        "微信图片 AES key 生成失败",
      );
      const fileKey = exactRandomBytes(
        randomBytesImpl,
        16,
        "微信图片文件标识生成失败",
      ).toString("hex");
      const ciphertext = encryptImage(image, aesKey);
      const uploadResponse = parseImageUploadResponse(await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "getuploadurl",
        body: {
          filekey: fileKey,
          media_type: 1,
          to_user_id: actorId,
          rawsize: image.length,
          rawfilemd5: createHash("md5").update(image).digest("hex"),
          filesize: ciphertext.length,
          no_need_thumb: true,
          aeskey: aesKey.toString("hex"),
          base_info: baseInfo(),
        },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信图片上传地址",
      }));
      const uploadUrl = resolveImageUploadUrl(uploadResponse, fileKey);
      const downloadParameter = await uploadImageCiphertext({
        fetchImpl,
        url: uploadUrl,
        ciphertext,
        timeoutMs: imageUploadTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "sendmessage",
        body: {
          msg: {
            from_user_id: "",
            to_user_id: actorId,
            client_id: createClientId(randomBytesImpl, nowImpl),
            message_type: 2,
            message_state: 2,
            item_list: [{
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: downloadParameter,
                  aes_key: Buffer.from(aesKey.toString("hex"))
                    .toString("base64"),
                  encrypt_type: 1,
                },
                mid_size: ciphertext.length,
              },
            }],
            context_token: contextToken,
          },
          base_info: baseInfo(),
        },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信图片发送",
      });
      parseSendResponse(raw);
    },

    async getTypingTicket(input, signal) {
      const actorId = validateActorInput(input.actorId);
      const contextToken = requiredInputString(
        input.contextToken,
        "微信输入状态上下文无效",
        65_536,
      );
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "getconfig",
        body: {
          ilink_user_id: actorId,
          context_token: contextToken,
          base_info: baseInfo(),
        },
        timeoutMs: typingTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信输入状态配置",
      });
      return parseTypingTicketResponse(raw);
    },

    async setTyping(input, signal) {
      const actorId = validateActorInput(input.actorId);
      const typingTicket = requiredInputString(
        input.typingTicket,
        "微信输入状态票据无效",
        65_536,
      );
      if (input.status !== "typing" && input.status !== "cancel") {
        throw new WeixinProtocolError(
          "invalid-input",
          "微信输入状态值无效",
        );
      }
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "sendtyping",
        body: {
          ilink_user_id: actorId,
          typing_ticket: typingTicket,
          status: input.status === "typing" ? 1 : 2,
          base_info: baseInfo(),
        },
        timeoutMs: typingTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信输入状态",
      });
      parseSendResponse(raw);
    },
  };
}

function parseUpdatesResponse(
  raw: string,
  accountId: string,
): WeixinUpdatesBatch {
  const messageIds = extractMessageIdLexemes(raw);
  const value = parseJsonRecord(raw, "微信长轮询响应");
  throwForApiError(value, "微信长轮询");
  const messages = value.msgs === undefined
    ? []
    : requiredArray(value.msgs, "微信长轮询消息列表无效");
  if (messages.length > 100 || messageIds.length !== messages.length) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信长轮询消息列表无效",
    );
  }
  const cursor = optionalResponseString(
    value.get_updates_buf,
    "微信长轮询响应游标无效",
    maximumCursorLength,
  );
  const suggestedTimeoutMs = optionalPositiveInteger(
    value.longpolling_timeout_ms,
    "微信长轮询建议超时时间无效",
  );
  return {
    cursor,
    messages: messages.map((message, index) =>
      parseInboundMessage(message, messageIds[index]!, accountId)),
    ...(suggestedTimeoutMs === undefined ? {} : { suggestedTimeoutMs }),
  };
}

function parseInboundMessage(
  value: unknown,
  messageId: string,
  accountId: string,
): WeixinInboundMessage {
  if (!/^\d{1,64}$/u.test(messageId)) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信消息 ID 无效",
    );
  }
  const record = requiredRecord(value, "微信消息格式无效");
  const messageType = optionalSafeInteger(
    record.message_type,
    "微信消息类型无效",
  );
  if (messageType !== 1) {
    return {
      kind: "ignored",
      messageId,
      reason: "unsupported-message-type",
    };
  }
  const messageState = optionalSafeInteger(
    record.message_state,
    "微信消息状态无效",
  );
  if (messageState !== 2) {
    return { kind: "ignored", messageId, reason: "unfinished" };
  }
  if (record.to_user_id !== accountId) {
    return { kind: "ignored", messageId, reason: "wrong-recipient" };
  }
  const actorId = validateResponseActorId(record.from_user_id);
  if (
    typeof record.context_token !== "string"
    || record.context_token.length === 0
    || record.context_token.length > 65_536
  ) {
    return { kind: "ignored", messageId, reason: "missing-context" };
  }
  const items = requiredArray(record.item_list, "微信消息项目列表无效");
  if (items.length > 100) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信消息项目列表无效",
    );
  }
  const content = parseInboundContent(items);
  if (content === null) {
    return { kind: "ignored", messageId, reason: "unsupported-content" };
  }
  const createdAt = optionalNonNegativeInteger(
    record.create_time_ms,
    "微信消息创建时间无效",
  );
  return {
    ...content,
    messageId,
    actorId,
    conversationId: actorId,
    contextToken: record.context_token,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function parseInboundContent(
  items: readonly unknown[],
): Pick<
    Extract<WeixinInboundMessage, { kind: "text" }>,
    "kind" | "text" | "quotedText" | "quotedMessageId"
  >
  | Pick<
      Extract<WeixinInboundMessage, { kind: "image" }>,
      "kind" | "text" | "quotedText" | "quotedMessageId" | "images"
    >
  | Pick<
      Extract<WeixinInboundMessage, { kind: "file" }>,
      "kind" | "text" | "quotedText" | "quotedMessageId" | "file"
    >
  | null {
  let text: string | undefined;
  let quotedText: string | undefined;
  let quotedMessageId: string | undefined;
  const images: WeixinImageReference[] = [];
  let file: WeixinFileReference | undefined;
  for (const item of items) {
    const record = requiredRecord(item, "微信消息项目无效");
    const type = optionalSafeInteger(
      record.type,
      "微信消息项目类型无效",
    );
    if (type === 1) {
      if (text !== undefined) {
        return null;
      }
      const textItem = requiredRecord(
        record.text_item,
        "微信文本消息项目无效",
      );
      if (
        typeof textItem.text !== "string"
        || textItem.text.trim().length === 0
        || textItem.text.length > 100_000
      ) {
        return null;
      }
      text = textItem.text;
      const quoted = parseQuotedReference(record.ref_msg);
      quotedText = quoted.text;
      quotedMessageId = quoted.messageId;
      continue;
    }
    if (type === 2) {
      if (file !== undefined || images.length >= maximumInboundImages) {
        return null;
      }
      images.push(parseImageReference(record));
      continue;
    }
    if (type === 4) {
      if (file !== undefined || images.length > 0) {
        return null;
      }
      file = parseFileReference(record);
      continue;
    }
    return null;
  }
  if (file !== undefined) {
    return {
      kind: "file",
      ...(text === undefined ? {} : { text }),
      ...(quotedText === undefined ? {} : { quotedText }),
      ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
      file,
    };
  }
  if (images.length > 0) {
    return {
      kind: "image",
      ...(text === undefined ? {} : { text }),
      ...(quotedText === undefined ? {} : { quotedText }),
      ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
      images,
    };
  }
  return text === undefined
    ? null
    : {
        kind: "text",
        text,
        ...(quotedText === undefined ? {} : { quotedText }),
        ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
      };
}

function parseQuotedReference(value: unknown): {
  text?: string;
  messageId?: string;
} {
  if (value === undefined) {
    return {};
  }
  const reference = requiredRecord(value, "微信引用消息无效");
  const title = optionalBoundedString(
    reference.title,
    "微信引用消息标题无效",
    10_000,
  )?.trim();
  const messageItemValue = reference.message_item;
  let messageText: string | undefined;
  let messageId: string | undefined;
  if (messageItemValue !== undefined) {
    const messageItem = requiredRecord(
      messageItemValue,
      "微信引用消息内容无效",
    );
    if (optionalSafeInteger(
      messageItem.type,
      "微信引用消息类型无效",
    ) === 1) {
      const textItem = requiredRecord(
        messageItem.text_item,
        "微信引用文本内容无效",
      );
      messageText = optionalBoundedString(
        textItem.text,
        "微信引用文本无效",
        100_000,
      )?.trim();
    }
    messageId = optionalBoundedString(
      messageItem.msg_id,
      "微信引用消息 ID 无效",
      64,
    );
    if (messageId !== undefined && !/^\d{1,64}$/u.test(messageId)) {
      throw new WeixinProtocolError(
        "invalid-response",
        "微信引用消息 ID 无效",
      );
    }
  }
  const parts = [title, messageText].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return {
    ...(parts.length === 0 ? {} : { text: parts.join(" | ") }),
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function parseImageReference(value: unknown): WeixinImageReference {
  const item = requiredRecord(value, "微信图片消息项目无效");
  const image = requiredRecord(
    item.image_item,
    "微信图片消息内容无效",
  );
  const media = requiredRecord(
    image.media,
    "微信图片媒体信息无效",
  );
  const fullUrl = optionalBoundedString(
    media.full_url,
    "微信图片完整地址无效",
    8_192,
  );
  const encryptedQueryParam = optionalBoundedString(
    media.encrypt_query_param,
    "微信图片下载参数无效",
    65_536,
  );
  if (fullUrl === undefined && encryptedQueryParam === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信图片没有可用下载地址",
    );
  }
  const imageAesKey = optionalBoundedString(
    image.aeskey,
    "微信图片 AES key 无效",
    1_024,
  );
  const mediaAesKey = optionalBoundedString(
    media.aes_key,
    "微信图片媒体 AES key 无效",
    1_024,
  );
  return {
    ...(fullUrl === undefined ? {} : { fullUrl }),
    ...(encryptedQueryParam === undefined
      ? {}
      : { encryptedQueryParam }),
    ...(imageAesKey === undefined ? {} : { imageAesKey }),
    ...(mediaAesKey === undefined ? {} : { mediaAesKey }),
  };
}

function parseFileReference(value: unknown): WeixinFileReference {
  const item = requiredRecord(value, "微信文件消息项目无效");
  const file = requiredRecord(
    item.file_item,
    "微信文件消息内容无效",
  );
  const media = requiredRecord(
    file.media,
    "微信文件媒体信息无效",
  );
  const fileName = optionalBoundedString(
    file.file_name,
    "微信文件名无效",
    1_024,
  );
  if (fileName === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信文件名无效",
    );
  }
  const fullUrl = optionalBoundedString(
    media.full_url,
    "微信文件完整地址无效",
    8_192,
  );
  const encryptedQueryParam = optionalBoundedString(
    media.encrypt_query_param,
    "微信文件下载参数无效",
    65_536,
  );
  if (fullUrl === undefined && encryptedQueryParam === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信文件没有可用下载地址",
    );
  }
  const mediaAesKey = optionalBoundedString(
    media.aes_key,
    "微信文件媒体 AES key 无效",
    1_024,
  );
  const declaredLength = optionalBoundedString(
    file.len,
    "微信文件声明长度无效",
    64,
  );
  const declaredMd5 = optionalBoundedString(
    file.md5,
    "微信文件声明 MD5 无效",
    128,
  );
  return {
    fileName,
    ...(fullUrl === undefined ? {} : { fullUrl }),
    ...(encryptedQueryParam === undefined
      ? {}
      : { encryptedQueryParam }),
    ...(mediaAesKey === undefined ? {} : { mediaAesKey }),
    ...(declaredLength === undefined ? {} : { declaredLength }),
    ...(declaredMd5 === undefined ? {} : { declaredMd5 }),
  };
}

interface WeixinImageUploadResponse {
  uploadFullUrl?: string;
  uploadParameter?: string;
}

function validateOutboundImage(value: unknown): Buffer {
  if (
    !Buffer.isBuffer(value)
    || value.length === 0
    || value.length > maximumImageBytes
  ) {
    throw new WeixinProtocolError(
      "invalid-input",
      value instanceof Uint8Array && value.length > maximumImageBytes
        ? "微信图片超过 10 MiB 限制"
        : "微信图片正文无效",
    );
  }
  if (!isPng(value) && !isJpeg(value)) {
    throw new WeixinProtocolError(
      "invalid-input",
      "微信图片不是受支持的 PNG 或 JPEG",
    );
  }
  return value;
}

function isPng(value: Buffer): boolean {
  const signature = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  return value.length >= signature.length
    && value.subarray(0, signature.length).equals(signature);
}

function isJpeg(value: Buffer): boolean {
  return value.length >= 3
    && value[0] === 0xff
    && value[1] === 0xd8
    && value[2] === 0xff;
}

function exactRandomBytes(
  randomBytesImpl: typeof randomBytes,
  length: number,
  message: string,
): Buffer {
  const value = randomBytesImpl(length);
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new WeixinProtocolError("invalid-input", message);
  }
  return value;
}

function encryptImage(value: Buffer, aesKey: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

function parseImageUploadResponse(raw: string): WeixinImageUploadResponse {
  const value = parseJsonRecord(raw, "微信图片上传地址响应");
  throwForApiError(value, "微信图片上传地址");
  const uploadFullUrl = optionalImageUploadString(
    value.upload_full_url,
    "微信图片完整上传地址无效",
    131_072,
  )?.trim();
  const uploadParameter = optionalImageUploadString(
    value.upload_param,
    "微信图片上传参数无效",
    maximumImageParameterLength,
  );
  if (!uploadFullUrl && uploadParameter === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信图片上传地址响应缺少上传参数",
    );
  }
  return {
    ...(uploadFullUrl ? { uploadFullUrl } : {}),
    ...(uploadParameter === undefined ? {} : { uploadParameter }),
  };
}

function resolveImageUploadUrl(
  response: WeixinImageUploadResponse,
  fileKey: string,
): URL {
  if (response.uploadFullUrl) {
    return validateImageUploadUrl(
      parseImageUploadUrl(response.uploadFullUrl),
    );
  }
  if (response.uploadParameter === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信图片上传地址响应缺少上传参数",
    );
  }
  const url = new URL(weixinCdnUploadPath, weixinCdnOrigin);
  url.searchParams.set(
    "encrypted_query_param",
    response.uploadParameter,
  );
  url.searchParams.set("filekey", fileKey);
  return validateImageUploadUrl(url);
}

function optionalImageUploadString(
  value: unknown,
  message: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

function parseImageUploadUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信图片上传地址无效",
    );
  }
}

function validateImageUploadUrl(url: URL): URL {
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.origin !== weixinCdnOrigin
    || url.pathname !== weixinCdnUploadPath
    || url.hash
  ) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信图片上传地址不属于固定官方 CDN",
    );
  }
  return url;
}

async function uploadImageCiphertext(options: {
  fetchImpl: typeof fetch;
  url: URL;
  ciphertext: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  let lastError: WeixinProtocolError | undefined;
  for (
    let attempt = 0;
    attempt < maximumImageUploadAttempts;
    attempt += 1
  ) {
    try {
      const response = await requestImageUpload(options);
      if (response.status >= 400 && response.status < 500) {
        throw new WeixinProtocolError(
          "http-error",
          `微信图片 CDN 上传失败（HTTP ${response.status}）`,
          response.status,
        );
      }
      if (response.status !== 200) {
        lastError = new WeixinProtocolError(
          "http-error",
          `微信图片 CDN 上传失败（HTTP ${response.status}）`,
          response.status,
        );
        continue;
      }
      const downloadParameter = response.headers.get("x-encrypted-param");
      if (
        typeof downloadParameter !== "string"
        || downloadParameter.length === 0
        || downloadParameter.length > maximumImageParameterLength
      ) {
        lastError = new WeixinProtocolError(
          "invalid-response",
          "微信图片 CDN 上传响应缺少下载参数",
        );
        continue;
      }
      return downloadParameter;
    } catch (error) {
      if (
        error instanceof WeixinProtocolError
        && (
          error.code === "aborted"
          || (error.code === "http-error" && error.status !== undefined
            && error.status >= 400 && error.status < 500)
        )
      ) {
        throw error;
      }
      lastError = error instanceof WeixinProtocolError
        ? error
        : new WeixinProtocolError(
            "network-error",
            "微信图片 CDN 上传网络请求失败",
          );
    }
  }
  throw lastError ?? new WeixinProtocolError(
    "network-error",
    "微信图片 CDN 上传网络请求失败",
  );
}

async function requestImageUpload(options: {
  fetchImpl: typeof fetch;
  url: URL;
  ciphertext: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) {
    throw new WeixinProtocolError("aborted", "微信图片 CDN 上传已取消");
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timeout.unref?.();
  try {
    return await options.fetchImpl(options.url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(options.ciphertext),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new WeixinProtocolError(
        options.signal?.aborted
          ? "aborted"
          : timedOut
            ? "timeout"
            : "network-error",
        options.signal?.aborted
          ? "微信图片 CDN 上传已取消"
          : timedOut
            ? "微信图片 CDN 上传超时"
            : "微信图片 CDN 上传网络请求失败",
      );
    }
    throw new WeixinProtocolError(
      "network-error",
      "微信图片 CDN 上传网络请求失败",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function parseSendResponse(raw: string): void {
  const value = parseJsonRecord(raw, "微信发送响应");
  throwForApiError(value, "微信发送");
}

function parseTypingTicketResponse(raw: string): string {
  const value = parseJsonRecord(raw, "微信输入状态配置响应");
  throwForApiError(value, "微信输入状态配置");
  return requiredResponseString(
    value.typing_ticket,
    "微信输入状态配置票据无效",
    65_536,
  );
}

async function request(options: {
  fetchImpl: typeof fetch;
  randomBytesImpl: typeof randomBytes;
  baseUrl: string;
  botToken: string;
  endpoint:
    | "getconfig"
    | "getupdates"
    | "getuploadurl"
    | "sendmessage"
    | "sendtyping";
  body: unknown;
  timeoutMs: number;
  maximumResponseBytes: number;
  signal?: AbortSignal;
  operation: string;
}): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) {
    throw new WeixinProtocolError(
      "aborted",
      `${options.operation}已取消`,
    );
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timeout.unref?.();
  try {
    const response = await options.fetchImpl(
      `${options.baseUrl}/ilink/bot/${options.endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.botToken}`,
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomWechatUin(options.randomBytesImpl),
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": String(appClientVersion),
        },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new WeixinProtocolError(
        "http-error",
        `${options.operation}请求失败（HTTP ${response.status}）`,
        response.status,
      );
    }
    return await readLimitedResponseText(
      response,
      options.maximumResponseBytes,
      options.operation,
    );
  } catch (error) {
    if (error instanceof WeixinProtocolError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new WeixinProtocolError(
        options.signal?.aborted
          ? "aborted"
          : timedOut
            ? "timeout"
            : "network-error",
        options.signal?.aborted
          ? `${options.operation}已取消`
          : timedOut
            ? `${options.operation}超时`
            : `${options.operation}网络请求失败`,
      );
    }
    throw new WeixinProtocolError(
      "network-error",
      `${options.operation}网络请求失败`,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function throwForApiError(
  value: Record<string, unknown>,
  operation: string,
): void {
  const ret = optionalSafeInteger(value.ret, `${operation}返回码无效`);
  const errorCode = optionalSafeInteger(
    value.errcode,
    `${operation}错误码无效`,
  );
  const failure = ret !== undefined && ret !== 0
    ? ret
    : errorCode !== undefined && errorCode !== 0
      ? errorCode
      : undefined;
  if (failure !== undefined) {
    throw new WeixinProtocolError(
      "api-error",
      `${operation}失败（返回码 ${failure}）`,
      undefined,
      failure,
    );
  }
}

function parseJsonRecord(
  raw: string,
  operation: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeixinProtocolError(
      "invalid-response",
      `${operation}不是有效 JSON`,
    );
  }
  return requiredRecord(value, `${operation}格式无效`);
}

function requiredRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

function validateResponseActorId(value: unknown): string {
  try {
    return validateWeixinActorId(value);
  } catch {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信消息发送者无效",
    );
  }
}

function validateAccountInput(value: unknown): string {
  try {
    return validateWeixinAccountId(value);
  } catch {
    throw new WeixinProtocolError("invalid-input", "微信账号 ID 无效");
  }
}

function validateActorInput(value: unknown): string {
  try {
    return validateWeixinActorId(value);
  } catch {
    throw new WeixinProtocolError("invalid-input", "微信用户 ID 无效");
  }
}

function validateBaseUrlInput(value: unknown): string {
  try {
    return validateWeixinBaseUrl(value);
  } catch {
    throw new WeixinProtocolError(
      "invalid-input",
      "微信业务 Base URL 无效",
    );
  }
}

function requiredInputString(
  value: unknown,
  message: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinProtocolError("invalid-input", message);
  }
  return value;
}

function requiredResponseString(
  value: unknown,
  message: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

function optionalInputString(
  value: unknown,
  message: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinProtocolError("invalid-input", message);
  }
  return value;
}

function optionalResponseString(
  value: unknown,
  message: string,
  maximumLength: number,
): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  message: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

function optionalSafeInteger(
  value: unknown,
  message: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value as number;
}

function optionalPositiveInteger(
  value: unknown,
  message: string,
): number | undefined {
  const parsed = optionalSafeInteger(value, message);
  if (parsed !== undefined && parsed <= 0) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return parsed;
}

function optionalNonNegativeInteger(
  value: unknown,
  message: string,
): number | undefined {
  const parsed = optionalSafeInteger(value, message);
  if (parsed !== undefined && parsed < 0) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return parsed;
}

function positiveTimeout(value: number, message: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WeixinProtocolError("invalid-input", message);
  }
  return value;
}

function baseInfo() {
  return {
    channel_version: "2.4.6",
    bot_agent: "CodexConnect/0.145.0",
  };
}

function createClientId(
  randomBytesImpl: typeof randomBytes,
  nowImpl: () => number,
): string {
  const suffix = randomBytesImpl(4);
  const now = nowImpl();
  if (
    !Buffer.isBuffer(suffix)
    || suffix.length !== 4
    || !Number.isSafeInteger(now)
    || now < 0
  ) {
    throw new WeixinProtocolError(
      "invalid-input",
      "微信发送客户端标识生成失败",
    );
  }
  return `codex-connect:${now}-${suffix.toString("hex")}`;
}

function randomWechatUin(randomBytesImpl: typeof randomBytes): string {
  const bytes = randomBytesImpl(4);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 4) {
    throw new WeixinProtocolError(
      "invalid-input",
      "微信随机请求标识生成失败",
    );
  }
  return Buffer.from(String(bytes.readUInt32BE(0)), "utf8").toString("base64");
}

async function readLimitedResponseText(
  response: Response,
  maximumBytes: number,
  operation: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new WeixinProtocolError(
      "invalid-response",
      `${operation}响应正文过大`,
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return value + decoder.decode();
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new WeixinProtocolError(
          "invalid-response",
          `${operation}响应正文过大`,
        );
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function extractMessageIdLexemes(raw: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < raw.length;) {
    if (raw[index] !== '"') {
      index += 1;
      continue;
    }
    const end = jsonStringEnd(raw, index);
    if (end === -1) {
      return values;
    }
    if (raw.slice(index, end + 1) === '"message_id"') {
      let cursor = skipWhitespace(raw, end + 1);
      if (raw[cursor] === ":") {
        cursor = skipWhitespace(raw, cursor + 1);
        const match = raw.slice(cursor).match(
          /^(?:0|[1-9]\d*)(?=\s*[,}\]])/u,
        );
        if (match) {
          values.push(match[0]);
        }
      }
    }
    index = end + 1;
  }
  return values;
}

function jsonStringEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (!escaped && character === '"') {
      return index;
    }
    if (character === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return -1;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}
