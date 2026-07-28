import { randomBytes } from "node:crypto";

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

export type WeixinInboundMessage =
  | {
      kind: "text";
      messageId: string;
      actorId: string;
      conversationId: string;
      contextToken: string;
      text: string;
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
  & WeixinTypingProtocolClient;

export interface CreateWeixinProtocolClientOptions {
  accountId: string;
  baseUrl: string;
  botToken: string;
  fetchImpl?: typeof fetch;
  getUpdatesTimeoutMs?: number;
  sendTimeoutMs?: number;
  typingTimeoutMs?: number;
  randomBytesImpl?: typeof randomBytes;
  nowImpl?: () => number;
}

const appClientVersion = (2 << 16) | (4 << 8) | 6;
const maximumCursorLength = 65_536;
const maximumGetUpdatesResponseBytes = 1_048_576;
const maximumSendResponseBytes = 65_536;
const maximumTextLength = 4_000;

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
  const text = firstText(items);
  if (text === null) {
    return { kind: "ignored", messageId, reason: "unsupported-content" };
  }
  const createdAt = optionalNonNegativeInteger(
    record.create_time_ms,
    "微信消息创建时间无效",
  );
  return {
    kind: "text",
    messageId,
    actorId,
    conversationId: actorId,
    contextToken: record.context_token,
    text,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function firstText(items: readonly unknown[]): string | null {
  for (const item of items) {
    const record = requiredRecord(item, "微信消息项目无效");
    const type = optionalSafeInteger(record.type, "微信消息项目类型无效");
    if (type !== 1) {
      continue;
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
    return textItem.text;
  }
  return null;
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
  endpoint: "getconfig" | "getupdates" | "sendmessage" | "sendtyping";
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
