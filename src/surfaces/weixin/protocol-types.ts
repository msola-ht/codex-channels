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

export interface WeixinAudioReference {
  fullUrl?: string;
  encryptedQueryParam?: string;
  mediaAesKey?: string;
  encodeType?: number;
  durationMs?: number;
  transcript?: string;
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
      kind: "audio";
      messageId: string;
      actorId: string;
      conversationId: string;
      contextToken: string;
      quotedText?: string;
      quotedMessageId?: string;
      audio: WeixinAudioReference;
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
