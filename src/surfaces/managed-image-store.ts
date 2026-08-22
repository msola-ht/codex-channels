import type { Readable } from "node:stream";

import { UserFacingError } from "../conversation-core/index.js";
import {
  readInputImage,
  type InputImageMimeType,
} from "./generated-image.js";
import { ManagedMediaStore } from "./managed-media-store.js";

export const maximumManagedImageBytes = 10 * 1024 * 1024;

const cleanupIntervalMs = 60 * 60 * 1000;
const defaultRetentionMs = 24 * 60 * 60 * 1000;

export interface ManagedImageSource {
  stream: Readable;
  contentLength?: number;
}

export interface StoredManagedImage {
  path: string;
  mimeType: InputImageMimeType;
  bytes: number;
}

export class ManagedImageStore {
  private readonly storage: ManagedMediaStore<StoredManagedImage["mimeType"]>;

  constructor(
    directory: string,
    onCleanupFailure: (error: unknown) => void,
    retentionMs = defaultRetentionMs,
  ) {
    this.storage = new ManagedMediaStore({
      directory,
      maximumBytes: maximumManagedImageBytes,
      retentionMs,
      cleanupIntervalMs,
      managedFileName: /^[0-9a-f-]+\.(?:gif|jpg|png|webp|part)$/u,
      closedMessage: "图片暂存器已经关闭",
      storeFailureMessage: "保存图片失败",
      invalidContentLength: (contentLength) =>
        contentLength > maximumManagedImageBytes,
      tooLargeError: () =>
        new UserFacingError("image.too-large", "图片超过 10 MiB 限制"),
      detectType: detectImageType,
      unsupportedError: () => new UserFacingError(
        "image.unsupported",
        "仅支持 PNG、JPEG、WebP 和非动画 GIF 图片",
      ),
      onCleanupFailure,
    });
  }

  async start(): Promise<void> {
    await this.storage.start();
  }

  close(): void {
    this.storage.close();
  }

  async store(source: ManagedImageSource): Promise<StoredManagedImage> {
    return await this.storage.store(source);
  }
}

async function detectImageType(path: string): Promise<{
  extension: "gif" | "jpg" | "png" | "webp";
  mimeType: InputImageMimeType;
} | undefined> {
  try {
    const image = await readInputImage(path);
    switch (image.format) {
      case "gif": return { extension: "gif", mimeType: "image/gif" };
      case "jpeg": return { extension: "jpg", mimeType: "image/jpeg" };
      case "png": return { extension: "png", mimeType: "image/png" };
      case "webp": return { extension: "webp", mimeType: "image/webp" };
    }
  } catch {
    return undefined;
  }
}
