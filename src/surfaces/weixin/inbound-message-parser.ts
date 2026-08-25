import { validateWeixinActorId } from "./credential-store.js";
import {
  optionalBoundedPositiveInteger,
  optionalBoundedString,
  optionalNonNegativeInteger,
  optionalResponseString,
  optionalSafeInteger,
  parseJsonRecord,
  requiredArray,
  requiredRecord,
  throwForApiError,
} from "./response-validation.js";
import {
  WeixinProtocolError,
  type WeixinAudioReference,
  type WeixinFileReference,
  type WeixinImageReference,
  type WeixinInboundMessage,
  type WeixinUpdatesBatch,
} from "./protocol-types.js";

export const maximumWeixinCursorLength = 65_536;

const minimumSuggestedGetUpdatesTimeoutMs = 1_000;
const maximumSuggestedGetUpdatesTimeoutMs = 120_000;
const maximumInboundImages = 4;

export function parseUpdatesResponse(
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
    maximumWeixinCursorLength,
  );
  const suggestedTimeoutMs = optionalBoundedPositiveInteger(
    value.longpolling_timeout_ms,
    "微信长轮询建议超时时间无效",
    minimumSuggestedGetUpdatesTimeoutMs,
    maximumSuggestedGetUpdatesTimeoutMs,
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
  | Pick<
      Extract<WeixinInboundMessage, { kind: "audio" }>,
      "kind" | "quotedText" | "quotedMessageId" | "audio"
    >
  | null {
  let text: string | undefined;
  let quotedText: string | undefined;
  let quotedMessageId: string | undefined;
  const images: WeixinImageReference[] = [];
  let file: WeixinFileReference | undefined;
  let audio: WeixinAudioReference | undefined;
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
      if (
        file !== undefined
        || audio !== undefined
        || images.length >= maximumInboundImages
      ) {
        return null;
      }
      images.push(parseImageReference(record));
      continue;
    }
    if (type === 3) {
      if (
        audio !== undefined
        || file !== undefined
        || images.length > 0
        || text !== undefined
      ) {
        return null;
      }
      audio = parseAudioReference(record);
      const quoted = parseQuotedReference(record.ref_msg);
      quotedText = quoted.text;
      quotedMessageId = quoted.messageId;
      continue;
    }
    if (type === 4) {
      if (file !== undefined || audio !== undefined || images.length > 0) {
        return null;
      }
      file = parseFileReference(record);
      continue;
    }
    return null;
  }
  if (audio !== undefined) {
    return {
      kind: "audio",
      ...(quotedText === undefined ? {} : { quotedText }),
      ...(quotedMessageId === undefined ? {} : { quotedMessageId }),
      audio,
    };
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

function parseAudioReference(value: unknown): WeixinAudioReference {
  const item = requiredRecord(value, "微信语音消息项目无效");
  const audio = requiredRecord(
    item.voice_item,
    "微信语音消息内容无效",
  );
  const mediaValue = audio.media;
  const media = mediaValue === undefined
    ? undefined
    : requiredRecord(mediaValue, "微信语音媒体信息无效");
  const fullUrl = media === undefined
    ? undefined
    : optionalBoundedString(
        media.full_url,
        "微信语音完整地址无效",
        8_192,
      );
  const encryptedQueryParam = media === undefined
    ? undefined
    : optionalBoundedString(
        media.encrypt_query_param,
        "微信语音下载参数无效",
        65_536,
      );
  const mediaAesKey = media === undefined
    ? undefined
    : optionalBoundedString(
        media.aes_key,
        "微信语音媒体 AES key 无效",
        1_024,
      );
  const transcript = optionalBoundedString(
    audio.text,
    "微信语音转写文本无效",
    100_000,
  )?.trim();
  if (
    transcript === undefined
    && fullUrl === undefined
    && encryptedQueryParam === undefined
  ) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信语音没有转写文本或可用下载地址",
    );
  }
  const encodeType = optionalSafeInteger(
    audio.encode_type,
    "微信语音编码类型无效",
  );
  if (
    encodeType !== undefined
    && (encodeType < 1 || encodeType > 8)
  ) {
    throw new WeixinProtocolError(
      "invalid-response",
      "微信语音编码类型无效",
    );
  }
  const durationMs = optionalNonNegativeInteger(
    audio.playtime,
    "微信语音时长无效",
  );
  return {
    ...(fullUrl === undefined ? {} : { fullUrl }),
    ...(encryptedQueryParam === undefined
      ? {}
      : { encryptedQueryParam }),
    ...(mediaAesKey === undefined ? {} : { mediaAesKey }),
    ...(encodeType === undefined ? {} : { encodeType }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(transcript === undefined || transcript.length === 0
      ? {}
      : { transcript }),
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
