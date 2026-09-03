import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import gatewayMetadata from "../../version.json" with { type: "json" };
import {
  validateWeixinAccountId,
  validateWeixinActorId,
  validateWeixinBaseUrl,
} from "./credential-store.js";
import { readBoundedFetchBody } from "./fetch-body.js";
import {
  withWeixinRequestAbort,
  WeixinRequestAbortError,
} from "./request-abort.js";
import {
  maximumWeixinCursorLength,
  parseUpdatesResponse,
} from "./inbound-message-parser.js";
import {
  WeixinProtocolError,
  type WeixinUpdatesBatch,
} from "./protocol-types.js";
import {
  parseJsonRecord,
  throwForApiError,
} from "./response-validation.js";

export { WeixinProtocolError } from "./protocol-types.js";
export type {
  WeixinAudioReference,
  WeixinFileReference,
  WeixinIgnoredMessageReason,
  WeixinImageReference,
  WeixinInboundMessage,
  WeixinProtocolErrorCode,
  WeixinUpdatesBatch,
} from "./protocol-types.js";

export interface WeixinProtocolClient {
  getUpdates(
    cursor: string,
    signal?: AbortSignal,
  ): Promise<WeixinUpdatesBatch>;
  sendText(
    input: {
      actorId: string;
      contextToken?: string;
      text: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WeixinImageSendProtocolClient {
  sendImage(
    input: {
      actorId: string;
      contextToken?: string;
      image: Buffer;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WeixinFileSendProtocolClient {
  sendFile(
    input: {
      actorId: string;
      contextToken?: string;
      fileName: string;
      file: Buffer;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export type WeixinTypingStatus = "cancel" | "typing";

export interface WeixinTypingProtocolClient {
  getTypingTicket(
    input: {
      actorId: string;
      contextToken?: string;
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

export interface WeixinLifecycleProtocolClient {
  notifyStart(signal?: AbortSignal): Promise<void>;
  notifyStop(signal?: AbortSignal): Promise<void>;
}

export type WeixinRuntimeProtocolClient =
  & WeixinProtocolClient
  & WeixinImageSendProtocolClient
  & WeixinFileSendProtocolClient
  & WeixinTypingProtocolClient
  & WeixinLifecycleProtocolClient;

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
const maximumGetUpdatesResponseBytes = 1_048_576;
const maximumSendResponseBytes = 65_536;
const maximumTextLength = 4_000;
const maximumImageBytes = 10 * 1024 * 1024;
export const maximumWeixinOutboundFileBytes = 1_000_000;
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
  let nextGetUpdatesTimeoutMs = getUpdatesTimeoutMs;
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
  const uploadMedia = async (
    value: Buffer,
    actorId: string,
    mediaType: 1 | 3,
    label: "图片" | "文件",
    signal?: AbortSignal,
  ): Promise<UploadedWeixinMedia> => {
    const aesKey = exactRandomBytes(
      randomBytesImpl,
      16,
      `微信${label} AES key 生成失败`,
    );
    const fileKey = exactRandomBytes(
      randomBytesImpl,
      16,
      `微信${label}文件标识生成失败`,
    ).toString("hex");
    const ciphertext = encryptMedia(value, aesKey);
    const uploadResponse = parseMediaUploadResponse(
      await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "getuploadurl",
        body: {
          filekey: fileKey,
          media_type: mediaType,
          to_user_id: actorId,
          rawsize: value.length,
          rawfilemd5: createHash("md5").update(value).digest("hex"),
          filesize: ciphertext.length,
          no_need_thumb: true,
          aeskey: aesKey.toString("hex"),
          base_info: baseInfo(),
        },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: `微信${label}上传地址`,
      }),
      label,
    );
    const uploadUrl = resolveMediaUploadUrl(
      uploadResponse,
      fileKey,
      label,
    );
    const downloadParameter = await uploadMediaCiphertext({
      fetchImpl,
      url: uploadUrl,
      ciphertext,
      timeoutMs: imageUploadTimeoutMs,
      label,
      ...(signal === undefined ? {} : { signal }),
    });
    return { aesKey, ciphertext, downloadParameter };
  };

  return {
    async notifyStart(signal) {
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "msg/notifystart",
        body: { base_info: baseInfo() },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信上线通知",
      });
      parseLifecycleResponse(raw, "微信上线通知");
    },

    async notifyStop(signal) {
      const raw = await request({
        fetchImpl,
        randomBytesImpl,
        baseUrl,
        botToken,
        endpoint: "msg/notifystop",
        body: { base_info: baseInfo() },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信下线通知",
      });
      parseLifecycleResponse(raw, "微信下线通知");
    },

    async getUpdates(cursor, signal) {
      const safeCursor = optionalInputString(
        cursor,
        "微信长轮询游标无效",
        maximumWeixinCursorLength,
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
        timeoutMs: nextGetUpdatesTimeoutMs,
        maximumResponseBytes: maximumGetUpdatesResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信长轮询",
      });
      const batch = parseUpdatesResponse(raw, accountId);
      if (batch.suggestedTimeoutMs !== undefined) {
        nextGetUpdatesTimeoutMs = batch.suggestedTimeoutMs;
      }
      return batch;
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
            ...(contextToken === undefined ? {} : { context_token: contextToken }),
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
      const uploaded = await uploadMedia(
        image,
        actorId,
        1,
        "图片",
        signal,
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
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParameter,
                  aes_key: Buffer.from(uploaded.aesKey.toString("hex"))
                    .toString("base64"),
                  encrypt_type: 1,
                },
                mid_size: uploaded.ciphertext.length,
              },
            }],
            ...(contextToken === undefined ? {} : { context_token: contextToken }),
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

    async sendFile(input, signal) {
      const actorId = validateActorInput(input.actorId);
      const contextToken = requiredInputString(
        input.contextToken,
        "微信文件回复上下文无效",
        maximumImageParameterLength,
      );
      const fileName = validateOutboundFileName(input.fileName);
      const file = validateOutboundFile(input.file);
      const uploaded = await uploadMedia(
        file,
        actorId,
        3,
        "文件",
        signal,
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
              type: 4,
              file_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParameter,
                  aes_key: Buffer.from(uploaded.aesKey.toString("hex"))
                    .toString("base64"),
                  encrypt_type: 1,
                },
                file_name: fileName,
                len: String(file.length),
              },
            }],
            ...(contextToken === undefined ? {} : { context_token: contextToken }),
          },
          base_info: baseInfo(),
        },
        timeoutMs: sendTimeoutMs,
        maximumResponseBytes: maximumSendResponseBytes,
        ...(signal === undefined ? {} : { signal }),
        operation: "微信文件发送",
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
          ...(contextToken === undefined ? {} : { context_token: contextToken }),
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

interface WeixinMediaUploadResponse {
  uploadFullUrl?: string;
  uploadParameter?: string;
}

interface UploadedWeixinMedia {
  aesKey: Buffer;
  ciphertext: Buffer;
  downloadParameter: string;
}

function validateOutboundFile(value: unknown): Buffer {
  if (
    !Buffer.isBuffer(value)
    || value.length === 0
    || value.length > maximumWeixinOutboundFileBytes
  ) {
    throw new WeixinProtocolError(
      "invalid-input",
      value instanceof Uint8Array
        && value.length > maximumWeixinOutboundFileBytes
        ? "微信文件超过 1,000,000 字节限制"
        : "微信文件正文无效",
    );
  }
  return value;
}

function validateOutboundFileName(value: unknown): string {
  const fileName = requiredInputString(
    value,
    "微信文件名无效",
    255,
  );
  if (
    fileName === "."
    || fileName === ".."
    || fileName.includes("/")
    || fileName.includes("\\")
    || Array.from(fileName).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined
        && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new WeixinProtocolError("invalid-input", "微信文件名无效");
  }
  return fileName;
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

function encryptMedia(value: Buffer, aesKey: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

function parseMediaUploadResponse(
  raw: string,
  label: "图片" | "文件",
): WeixinMediaUploadResponse {
  const operation = `微信${label}上传地址`;
  const value = parseJsonRecord(raw, `${operation}响应`);
  throwForApiError(value, operation);
  const uploadFullUrl = optionalMediaUploadString(
    value.upload_full_url,
    `微信${label}完整上传地址无效`,
    131_072,
  )?.trim();
  const uploadParameter = optionalMediaUploadString(
    value.upload_param,
    `微信${label}上传参数无效`,
    maximumImageParameterLength,
  );
  if (!uploadFullUrl && uploadParameter === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      `${operation}响应缺少上传参数`,
    );
  }
  return {
    ...(uploadFullUrl ? { uploadFullUrl } : {}),
    ...(uploadParameter === undefined ? {} : { uploadParameter }),
  };
}

function resolveMediaUploadUrl(
  response: WeixinMediaUploadResponse,
  fileKey: string,
  label: "图片" | "文件",
): URL {
  if (response.uploadFullUrl) {
    return validateMediaUploadUrl(
      parseMediaUploadUrl(response.uploadFullUrl, label),
      label,
    );
  }
  if (response.uploadParameter === undefined) {
    throw new WeixinProtocolError(
      "invalid-response",
      `微信${label}上传地址响应缺少上传参数`,
    );
  }
  const url = new URL(weixinCdnUploadPath, weixinCdnOrigin);
  url.searchParams.set(
    "encrypted_query_param",
    response.uploadParameter,
  );
  url.searchParams.set("filekey", fileKey);
  return validateMediaUploadUrl(url, label);
}

function optionalMediaUploadString(
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

function parseMediaUploadUrl(
  value: string,
  label: "图片" | "文件",
): URL {
  try {
    return new URL(value);
  } catch {
    throw new WeixinProtocolError(
      "invalid-response",
      `微信${label}上传地址无效`,
    );
  }
}

function validateMediaUploadUrl(
  url: URL,
  label: "图片" | "文件",
): URL {
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
      `微信${label}上传地址不属于固定官方 CDN`,
    );
  }
  return url;
}

async function uploadMediaCiphertext(options: {
  fetchImpl: typeof fetch;
  url: URL;
  ciphertext: Buffer;
  timeoutMs: number;
  label: "图片" | "文件";
  signal?: AbortSignal;
}): Promise<string> {
  let lastError: WeixinProtocolError | undefined;
  for (
    let attempt = 0;
    attempt < maximumImageUploadAttempts;
    attempt += 1
  ) {
    try {
      const response = await requestMediaUpload(options);
      if (response.status >= 400 && response.status < 500) {
        throw new WeixinProtocolError(
          "http-error",
          `微信${options.label} CDN 上传失败（HTTP ${response.status}）`,
          response.status,
        );
      }
      if (response.status !== 200) {
        lastError = new WeixinProtocolError(
          "http-error",
          `微信${options.label} CDN 上传失败（HTTP ${response.status}）`,
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
          `微信${options.label} CDN 上传响应缺少下载参数`,
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
            `微信${options.label} CDN 上传网络请求失败`,
          );
    }
  }
  throw lastError ?? new WeixinProtocolError(
    "network-error",
    `微信${options.label} CDN 上传网络请求失败`,
  );
}

async function requestMediaUpload(options: {
  fetchImpl: typeof fetch;
  url: URL;
  ciphertext: Buffer;
  timeoutMs: number;
  label: "图片" | "文件";
  signal?: AbortSignal;
}): Promise<Response> {
  try {
    return await withWeixinRequestAbort(
      {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (signal) => options.fetchImpl(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(options.ciphertext),
        redirect: "error",
        signal,
      }),
    );
  } catch (error) {
    throw toWeixinNetworkError(error, `微信${options.label} CDN 上传`);
  }
}

function parseSendResponse(raw: string): void {
  const value = parseJsonRecord(raw, "微信发送响应");
  throwForApiError(value, "微信发送");
}

function parseLifecycleResponse(raw: string, operation: string): void {
  const value = parseJsonRecord(raw, `${operation}响应`);
  throwForApiError(value, operation);
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
    | "msg/notifystart"
    | "msg/notifystop"
    | "sendmessage"
    | "sendtyping";
  body: unknown;
  timeoutMs: number;
  maximumResponseBytes: number;
  signal?: AbortSignal;
  operation: string;
}): Promise<string> {
  try {
    return await withWeixinRequestAbort(
      {
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      async (signal) => {
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
            signal,
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
      },
    );
  } catch (error) {
    if (error instanceof WeixinProtocolError) {
      throw error;
    }
    throw toWeixinNetworkError(error, options.operation);
  }
}

function toWeixinNetworkError(
  error: unknown,
  operation: string,
): WeixinProtocolError {
  const code = error instanceof WeixinRequestAbortError
    ? error.reason === "network-abort"
      ? "network-error"
      : error.reason
    : "network-error";
  return new WeixinProtocolError(
    code,
    code === "aborted"
      ? `${operation}已取消`
      : code === "timeout"
        ? `${operation}超时`
        : `${operation}网络请求失败`,
  );
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

function positiveTimeout(value: number, message: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WeixinProtocolError("invalid-input", message);
  }
  return value;
}

function baseInfo() {
  return {
    channel_version: "2.4.6",
    bot_agent: `CodexConnect/${gatewayMetadata.version}`,
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
  const content = await readBoundedFetchBody(
    response,
    maximumBytes,
    () => new WeixinProtocolError(
      "invalid-response",
      `${operation}响应 Content-Length 无效`,
    ),
    () => new WeixinProtocolError(
      "invalid-response",
      `${operation}响应正文过大`,
    ),
  );
  return new TextDecoder().decode(content);
}
