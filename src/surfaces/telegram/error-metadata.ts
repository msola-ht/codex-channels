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
