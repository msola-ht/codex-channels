import { open } from "node:fs/promises";
import type { Readable } from "node:stream";

import { UserFacingError } from "../conversation-core/index.js";
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
  mimeType: "image/jpeg" | "image/png";
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
      managedFileName: /^[0-9a-f-]+\.(?:jpg|png|part)$/u,
      closedMessage: "图片暂存器已经关闭",
      storeFailureMessage: "保存图片失败",
      invalidContentLength: (contentLength) =>
        contentLength > maximumManagedImageBytes,
      tooLargeError: () =>
        new UserFacingError("image.too-large", "图片超过 10 MiB 限制"),
      detectType: detectImageType,
      unsupportedError: () =>
        new UserFacingError("image.unsupported", "仅支持 PNG 和 JPEG 图片"),
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
  extension: "jpg" | "png";
  mimeType: "image/jpeg" | "image/png";
} | undefined> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return { extension: "jpg", mimeType: "image/jpeg" };
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytesRead === png.length && header.equals(png)) {
      return { extension: "png", mimeType: "image/png" };
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
