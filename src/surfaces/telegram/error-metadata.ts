import {
  surfaceErrorMetadata,
  type SurfaceErrorMetadata,
} from "../error-metadata.js";
import { GrammyError, HttpError } from "grammy";

export type TelegramErrorMetadata = SurfaceErrorMetadata;
export function telegramErrorMetadata(error: unknown): TelegramErrorMetadata {
  const metadata = surfaceErrorMetadata(error);
  if (error instanceof GrammyError && error.error_code === 400
    && error.description.toLowerCase().includes("message is not modified")) {
    return { ...metadata, telegramReason: "message-not-modified" };
  }
  if (error instanceof HttpError) {
    const cause = surfaceErrorMetadata(error.error);
    return { ...metadata, causeType: cause.errorType,
      ...(cause.errorCode === undefined ? {} : { causeCode: cause.errorCode }) };
  }
  return metadata;
}

/** 只允许明确被平台拒绝的请求降级；网络异常不能证明新建消息未被接收。 */
export function isTelegramBadRequest(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400;
}

export function isTelegramFormatRejection(error: unknown): boolean {
  return isTelegramBadRequest(error) && error instanceof GrammyError
    && /can't parse|cannot parse|unsupported (?:start tag|parse_mode)|entity|entities|rich message/i.test(error.description);
}

export function isTelegramMissingMessage(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400
    && /message to edit not found|message can't be edited/i.test(error.description);
}

export function isTelegramDeliveryUncertain(error: unknown): boolean {
  return !(error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500);
}

export function isTelegramMessageNotModified(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("message is not modified");
}
