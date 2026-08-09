import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readGatewayConfig,
  validateGatewayConfigDocument,
} from "../runtime/gateway-config.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const appClientVersion = (2 << 16) | (4 << 8) | 6;
const maximumResponseBytes = 1_048_576;
const responseCursor = Symbol("responseCursor");
const responseMessageIds = Symbol("responseMessageIds");
const responseReplyContexts = new WeakMap();
const responseImageContexts = new WeakMap();
const responseFileContexts = new WeakMap();

export class WeixinUpdatesContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinUpdatesContractError";
    this.code = code;
  }
}

export function createWeixinUpdatesContractClient({
  fetchImpl = fetch,
  timeoutMs = 40_000,
  randomBytesImpl = randomBytes,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WeixinUpdatesContractError(
      "invalid-input",
      "微信长轮询超时时间无效",
    );
  }
  return {
    async pollOnce({ baseUrl, botToken, cursor = "", signal }) {
      const origin = normalizeBaseUrl(baseUrl);
      const token = requiredString(botToken, "微信 Bot Token 无效", 16_384);
      const safeCursor = optionalInputString(
        cursor,
        "微信长轮询游标无效",
        65_536,
      );
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      if (signal?.aborted) {
        throw new WeixinUpdatesContractError("aborted", "微信长轮询已取消");
      }
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetchImpl(`${origin}/ilink/bot/getupdates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            AuthorizationType: "ilink_bot_token",
            "X-WECHAT-UIN": randomWechatUin(randomBytesImpl),
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": String(appClientVersion),
          },
          body: JSON.stringify({
            get_updates_buf: safeCursor,
            base_info: {
              channel_version: "2.4.6",
              bot_agent: "CodexConnect/0.147.0",
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new WeixinUpdatesContractError(
            "http-error",
            `微信长轮询请求失败（HTTP ${response.status}）`,
          );
        }
        const raw = await readLimitedResponseText(
          response,
          maximumResponseBytes,
        );
        const summary = summarizeResponse(raw);
        const parsed = JSON.parse(raw);
        Object.defineProperty(summary, responseCursor, {
          value: typeof parsed.get_updates_buf === "string"
            ? parsed.get_updates_buf
            : "",
        });
        Object.defineProperty(summary, responseMessageIds, {
          value: extractMessageIdLexemes(raw),
        });
        responseReplyContexts.set(summary, extractReplyContexts(parsed));
        responseImageContexts.set(summary, extractImageContexts(parsed));
        responseFileContexts.set(summary, extractFileContexts(parsed));
        return summary;
      } catch (error) {
        if (error instanceof WeixinUpdatesContractError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new WeixinUpdatesContractError(
            signal?.aborted ? "aborted" : timedOut ? "timeout" : "network-error",
            signal?.aborted
              ? "微信长轮询已取消"
              : timedOut
                ? "微信长轮询等待超时"
                : "微信长轮询网络请求失败",
          );
        }
        throw new WeixinUpdatesContractError(
          "network-error",
          "微信长轮询网络请求失败",
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export function selectWeixinReplyContext(summary, allowedUserIds) {
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
    throw new WeixinUpdatesContractError(
      "invalid-input",
      "微信允许用户列表无效",
    );
  }
  const allowed = new Set(allowedUserIds);
  const contexts = responseReplyContexts.get(summary) ?? [];
  responseReplyContexts.delete(summary);
  const selected = contexts.findLast((context) =>
    allowed.has(context.toUserId));
  if (!selected) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "本批消息中没有可用于回复的已授权完成态文本",
    );
  }
  return selected;
}

export function selectWeixinImageContext(summary, allowedUserIds) {
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
    throw new WeixinUpdatesContractError(
      "invalid-input",
      "微信允许用户列表无效",
    );
  }
  const allowed = new Set(allowedUserIds);
  const contexts = responseImageContexts.get(summary) ?? [];
  responseImageContexts.delete(summary);
  const selected = contexts.findLast((context) =>
    allowed.has(context.fromUserId));
  if (!selected) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "本批消息中没有已授权完成态图片",
    );
  }
  return selected;
}

export function selectWeixinFileContext(summary, allowedUserIds) {
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
    throw new WeixinUpdatesContractError(
      "invalid-input",
      "微信允许用户列表无效",
    );
  }
  const allowed = new Set(allowedUserIds);
  const contexts = responseFileContexts.get(summary) ?? [];
  responseFileContexts.delete(summary);
  const selected = contexts.findLast((context) =>
    allowed.has(context.fromUserId));
  if (!selected) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "本批消息中没有已授权完成态一般文件",
    );
  }
  return selected;
}

export function continueWeixinUpdatesContract({
  client,
  previous,
  baseUrl,
  botToken,
  signal,
}) {
  const cursor = previous?.[responseCursor];
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new WeixinUpdatesContractError(
      "invalid-input",
      "微信上一批次没有可继续使用的内存游标",
    );
  }
  return client.pollOnce({
    baseUrl,
    botToken,
    cursor,
    signal,
  });
}

export async function runWeixinUpdatesSequence({
  client,
  baseUrl,
  botToken,
  signal,
  onSecondPoll = () => {},
}) {
  const first = await client.pollOnce({
    baseUrl,
    botToken,
    signal,
  });
  if (first.kind !== "success" || !first[responseCursor]) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "微信首轮长轮询未返回可用游标",
    );
  }
  onSecondPoll(first);
  const second = await client.pollOnce({
    baseUrl,
    botToken,
    cursor: first[responseCursor],
    signal,
  });
  if (second.kind !== "success") {
    return { first, second };
  }
  const firstIds = new Set(first[responseMessageIds] ?? []);
  const secondIds = second[responseMessageIds] ?? [];
  return {
    first,
    second,
    cursorAdvanced: Boolean(second[responseCursor])
      && second[responseCursor] !== first[responseCursor],
    replayedMessageCount: secondIds.filter((id) => firstIds.has(id)).length,
  };
}

export async function runWeixinUpdatesReplaySequence({
  client,
  baseUrl,
  botToken,
  signal,
  onSecondPoll = () => {},
  onReplayPoll = () => {},
}) {
  const sequence = await runWeixinUpdatesSequence({
    client,
    baseUrl,
    botToken,
    signal,
    onSecondPoll,
  });
  if (
    sequence.first.kind !== "success"
    || sequence.second.kind !== "success"
    || !sequence.first[responseCursor]
  ) {
    return sequence;
  }
  onReplayPoll(sequence);
  let third;
  try {
    third = await client.pollOnce({
      baseUrl,
      botToken,
      cursor: sequence.first[responseCursor],
      signal,
    });
  } catch (error) {
    if (
      error instanceof WeixinUpdatesContractError
      && error.code === "timeout"
    ) {
      return {
        ...sequence,
        thirdTimedOut: true,
        secondBatchReplayCount: 0,
      };
    }
    throw error;
  }
  if (third.kind !== "success") {
    return { ...sequence, third };
  }
  const secondIds = new Set(sequence.second[responseMessageIds] ?? []);
  const thirdIds = third[responseMessageIds] ?? [];
  return {
    ...sequence,
    third,
    thirdTimedOut: false,
    thirdCursorMatchesSecond: Boolean(third[responseCursor])
      && third[responseCursor] === sequence.second[responseCursor],
    secondBatchReplayCount: thirdIds.filter((id) => secondIds.has(id)).length,
  };
}

export function summarizeResponse(raw) {
  const messageIdLexemes = extractMessageIdLexemes(raw);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "微信长轮询响应不是有效 JSON",
    );
  }
  const record = requiredRecord(value);
  const ret = optionalSafeInteger(record.ret, "ret");
  const errorCode = optionalSafeInteger(record.errcode, "errcode");
  if ((ret !== undefined && ret !== 0) || (errorCode !== undefined && errorCode !== 0)) {
    return {
      kind: "api-error",
      ...(ret === undefined ? {} : { ret }),
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }
  const messages = record.msgs === undefined
    ? []
    : requiredArray(record.msgs, "msgs");
  if (messages.length > 100 || messageIdLexemes.length !== messages.length) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "微信长轮询消息列表无效",
    );
  }
  const nextCursor = optionalString(
    record.get_updates_buf,
    "微信长轮询响应游标无效",
    65_536,
  );
  const suggestedTimeoutMs = optionalPositiveInteger(
    record.longpolling_timeout_ms,
    "longpolling_timeout_ms",
  );
  return {
    kind: "success",
    messageCount: messages.length,
    hasNextCursor: nextCursor.length > 0,
    ...(suggestedTimeoutMs === undefined ? {} : { suggestedTimeoutMs }),
    messages: messages.map((message, index) =>
      summarizeMessage(message, messageIdLexemes[index])),
  };
}

function summarizeMessage(value, messageIdLexeme) {
  const record = requiredRecord(value);
  const items = record.item_list === undefined
    ? []
    : requiredArray(record.item_list, "item_list");
  if (items.length > 100) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "微信消息项目列表无效",
    );
  }
  const fromUserId = requiredResponseString(
    record.from_user_id,
    "微信消息发送者无效",
    1_024,
  );
  const references = items.flatMap((item) => {
    const itemRecord = requiredRecord(item);
    if (itemRecord.ref_msg === undefined) {
      return [];
    }
    const reference = requiredRecord(itemRecord.ref_msg);
    const referencedItem = reference.message_item === undefined
      ? undefined
      : requiredRecord(reference.message_item);
    const referencedText = referencedItem?.text_item === undefined
      ? undefined
      : requiredRecord(referencedItem.text_item).text;
    return [{
      referenceFields: safeFieldNames(reference),
      hasTitle: typeof reference.title === "string"
        && reference.title.length > 0,
      referencedItemFields: referencedItem === undefined
        ? []
        : safeFieldNames(referencedItem),
      referencedMessageIdShape: referencedMessageIdShape(
        referencedItem?.msg_id,
      ),
      referencedItemType: optionalSafeInteger(
        referencedItem?.type,
        "ref_msg.message_item.type",
      ),
      hasReferencedText: typeof referencedText === "string"
        && referencedText.length > 0,
    }];
  });
  return {
    fromUserShape: fromUserId.endsWith("@im.wechat")
      ? "wechat-user"
      : "unknown",
    messageType: optionalSafeInteger(record.message_type, "message_type"),
    messageState: optionalSafeInteger(record.message_state, "message_state"),
    itemTypes: items.map((item) =>
      optionalSafeInteger(requiredRecord(item).type, "item.type") ?? 0),
    ...(clientIdShape(record.client_id) === "missing"
      ? {}
      : { clientIdShape: clientIdShape(record.client_id) }),
    ...(references.length === 0 ? {} : { references }),
    hasContextToken: typeof record.context_token === "string"
      && record.context_token.length > 0,
    messageIdDigits: messageIdLexeme.replace(/^-?/u, "").length,
    messageIdSafeInteger: isSafeIntegerLexeme(messageIdLexeme),
  };
}

function safeFieldNames(value) {
  return Object.keys(value)
    .filter((field) => /^[a-z][a-z0-9_]{0,63}$/u.test(field))
    .sort()
    .slice(0, 20);
}

function referencedMessageIdShape(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "missing";
  }
  if (/^\d{1,64}$/u.test(value)) {
    return "numeric";
  }
  if (/^codex-connect:\d{1,20}-[0-9a-f]{8}$/u.test(value)) {
    return "codex-connect-client";
  }
  return "other";
}

function clientIdShape(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "missing";
  }
  if (/^codex-connect:\d{1,20}-[0-9a-f]{8}$/u.test(value)) {
    return "codex-connect-client";
  }
  return "other";
}

function extractReplyContexts(value) {
  if (
    typeof value !== "object"
    || value === null
    || !Array.isArray(value.msgs)
  ) {
    return [];
  }
  const contexts = [];
  for (const message of value.msgs) {
    if (
      typeof message !== "object"
      || message === null
      || message.message_type !== 1
      || message.message_state !== 2
      || typeof message.from_user_id !== "string"
      || message.from_user_id.length === 0
      || message.from_user_id.length > 1_024
      || typeof message.context_token !== "string"
      || message.context_token.length === 0
      || message.context_token.length > 65_536
      || !Array.isArray(message.item_list)
      || !message.item_list.some((item) =>
        typeof item === "object"
        && item !== null
        && item.type === 1
        && typeof item.text_item === "object"
        && item.text_item !== null
        && typeof item.text_item.text === "string"
        && item.text_item.text.length > 0)
    ) {
      continue;
    }
    contexts.push({
      toUserId: message.from_user_id,
      contextToken: message.context_token,
    });
  }
  return contexts;
}

function extractImageContexts(value) {
  if (
    typeof value !== "object"
    || value === null
    || !Array.isArray(value.msgs)
  ) {
    return [];
  }
  const contexts = [];
  for (const message of value.msgs) {
    if (
      typeof message !== "object"
      || message === null
      || message.message_type !== 1
      || message.message_state !== 2
      || typeof message.from_user_id !== "string"
      || message.from_user_id.length === 0
      || message.from_user_id.length > 1_024
      || !Array.isArray(message.item_list)
    ) {
      continue;
    }
    for (const item of message.item_list) {
      if (
        typeof item !== "object"
        || item === null
        || item.type !== 2
        || typeof item.image_item !== "object"
        || item.image_item === null
        || typeof item.image_item.media !== "object"
        || item.image_item.media === null
      ) {
        continue;
      }
      contexts.push({
        fromUserId: message.from_user_id,
        fullUrl: boundedOptionalString(item.image_item.media.full_url, 8_192),
        encryptedQueryParam: boundedOptionalString(
          item.image_item.media.encrypt_query_param,
          65_536,
        ),
        imageAesKey: boundedOptionalString(item.image_item.aeskey, 1_024),
        mediaAesKey: boundedOptionalString(
          item.image_item.media.aes_key,
          1_024,
        ),
      });
    }
  }
  return contexts;
}

function extractFileContexts(value) {
  if (
    typeof value !== "object"
    || value === null
    || !Array.isArray(value.msgs)
  ) {
    return [];
  }
  const contexts = [];
  for (const message of value.msgs) {
    if (
      typeof message !== "object"
      || message === null
      || message.message_type !== 1
      || message.message_state !== 2
      || typeof message.from_user_id !== "string"
      || message.from_user_id.length === 0
      || message.from_user_id.length > 1_024
      || !Array.isArray(message.item_list)
    ) {
      continue;
    }
    for (const item of message.item_list) {
      if (
        typeof item !== "object"
        || item === null
        || item.type !== 4
        || typeof item.file_item !== "object"
        || item.file_item === null
        || typeof item.file_item.media !== "object"
        || item.file_item.media === null
      ) {
        continue;
      }
      contexts.push({
        fromUserId: message.from_user_id,
        fullUrl: boundedOptionalString(item.file_item.media.full_url, 8_192),
        encryptedQueryParam: boundedOptionalString(
          item.file_item.media.encrypt_query_param,
          65_536,
        ),
        mediaAesKey: boundedOptionalString(
          item.file_item.media.aes_key,
          1_024,
        ),
        fileName: boundedOptionalString(item.file_item.file_name, 1_024),
        declaredLength: boundedOptionalString(item.file_item.len, 64),
        declaredMd5: boundedOptionalString(item.file_item.md5, 128),
      });
    }
  }
  return contexts;
}

function boundedOptionalString(value, maximumLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    ? value
    : undefined;
}

function extractMessageIdLexemes(raw) {
  const values = [];
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
        const match = raw.slice(cursor).match(/^-?\d+/u);
        if (match) {
          values.push(match[0]);
        }
      }
    }
    index = end + 1;
  }
  return values;
}

function jsonStringEnd(value, start) {
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

function skipWhitespace(value, start) {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isSafeIntegerLexeme(value) {
  try {
    const parsed = BigInt(value);
    return parsed >= BigInt(Number.MIN_SAFE_INTEGER)
      && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function randomWechatUin(randomBytesImpl) {
  const bytes = randomBytesImpl(4);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 4) {
    throw new WeixinUpdatesContractError(
      "invalid-input",
      "微信随机请求标识生成失败",
    );
  }
  return Buffer.from(String(bytes.readUInt32BE(0)), "utf8").toString("base64");
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinUpdatesContractError("invalid-input", "微信业务 Base URL 无效");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || (
      hostname !== "weixin.qq.com"
      && !hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new WeixinUpdatesContractError("invalid-input", "微信业务 Base URL 无效");
  }
  return url.origin;
}

function requiredRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeixinUpdatesContractError("invalid-response", "微信长轮询响应格式无效");
  }
  return value;
}

function requiredArray(value, field) {
  if (!Array.isArray(value)) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      `微信长轮询响应字段 ${field} 无效`,
    );
  }
  return value;
}

function requiredString(value, message, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinUpdatesContractError("invalid-input", message);
  }
  return value;
}

function requiredResponseString(value, message, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinUpdatesContractError("invalid-response", message);
  }
  return value;
}

function optionalInputString(value, message, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinUpdatesContractError("invalid-input", message);
  }
  return value;
}

function optionalString(value, message, maximumLength) {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinUpdatesContractError("invalid-response", message);
  }
  return value;
}

function optionalSafeInteger(value, field) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      `微信长轮询响应字段 ${field} 无效`,
    );
  }
  return value;
}

function optionalPositiveInteger(value, field) {
  const parsed = optionalSafeInteger(value, field);
  if (parsed !== undefined && parsed <= 0) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      `微信长轮询响应字段 ${field} 无效`,
    );
  }
  return parsed;
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new WeixinUpdatesContractError(
      "invalid-response",
      "微信长轮询响应正文过大",
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
        throw new WeixinUpdatesContractError(
          "invalid-response",
          "微信长轮询响应正文过大",
        );
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function loadConfiguredWeixinContractConnection(environment) {
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = validateGatewayConfigDocument(readGatewayConfig(configPath));
  if (!document.weixin) {
    throw new WeixinUpdatesContractError(
      "not-configured",
      "微信尚未配置，请先运行 codexc setup",
    );
  }
  const module = await import("../dist/surfaces/weixin/index.js");
  const store = module.createWeixinCredentialStore(
    join(dataDir, "credentials", "weixin"),
  );
  const credential = await store.get(document.weixin.account_id);
  if (!credential) {
    throw new WeixinUpdatesContractError(
      "not-configured",
      "微信安全凭据不存在，请重新运行 codexc setup",
    );
  }
  return {
    credential,
    allowedUserIds: [...document.weixin.allowed_user_ids],
  };
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write([
      "微信 getupdates 合同探针（阶段 0，不保存消息或游标）",
      "",
      "用法：",
      "  node scripts/weixin-updates-contract-probe.mjs once --live",
      "  node scripts/weixin-updates-contract-probe.mjs sequence --live",
      "  node scripts/weixin-updates-contract-probe.mjs replay --live",
      "",
      "只有显式传入上述模式和 --live 才读取微信安全凭据并执行长轮询。",
      "不会输出消息正文、Token、context_token、游标或完整用户标识。",
      "",
    ].join("\n"));
    return 0;
  }
  if (
    argv.length !== 2
    || !["once", "sequence", "replay"].includes(argv[0])
    || argv[1] !== "--live"
  ) {
    process.stderr.write("参数无效；请使用 --help 查看用法。\n");
    return 2;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const { credential } = await loadConfiguredWeixinContractConnection(
      process.env,
    );
    process.stdout.write(
      "开始一次微信长轮询；请现在从已允许的微信账号向机器人发送一条测试文本。\n",
    );
    const client = createWeixinUpdatesContractClient();
    const sequenceOptions = {
      client,
      baseUrl: credential.baseUrl,
      botToken: credential.botToken,
      signal: controller.signal,
      onSecondPoll: () => {
        process.stdout.write(
          "首轮已取得内存游标；请现在发送一条新的测试文本，开始第二轮。\n",
        );
      },
    };
    const result = argv[0] === "replay"
      ? await runWeixinUpdatesReplaySequence({
          ...sequenceOptions,
          onReplayPoll: () => {
            process.stdout.write(
              "第二轮已完成；第三轮将复用旧游标，请不要再发送消息。\n",
            );
          },
        })
      : argv[0] === "sequence"
        ? await runWeixinUpdatesSequence({
            ...sequenceOptions,
          })
        : await client.pollOnce({
            baseUrl: credential.baseUrl,
            botToken: credential.botToken,
            signal: controller.signal,
          });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write("本次未保存返回游标；再次探测可能收到重放消息。\n");
    return 0;
  } catch (error) {
    const message = error instanceof WeixinUpdatesContractError
      ? error.message
      : "微信长轮询合同探针失败";
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
