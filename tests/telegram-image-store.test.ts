import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  maximumTelegramImageBytes,
  TelegramImageStore,
  type ImageDownloader,
} from "../src/surfaces/telegram/image-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TelegramImageStore", () => {
  it("downloads a JPEG into a private managed directory", async () => {
    const directory = temporaryDirectory();
    let requestedUrl: URL | undefined;
    const downloader: ImageDownloader = async (url) => {
      requestedUrl = url;
      return { stream: Readable.from([jpegBytes()]), contentLength: jpegBytes().length };
    };
    const store = new TelegramImageStore(
      directory,
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      60_000,
      downloader,
    );
    await store.start();

    const image = await store.download(
      { getFile: async () => ({ file_path: "photos/file_1.jpg" }) },
      "telegram-file-id",
    );

    expect(requestedUrl?.hostname).toBe("api.telegram.org");
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.path.startsWith(directory)).toBe(true);
    expect(readFileSync(image.path)).toEqual(jpegBytes());
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(image.path).mode & 0o777).toBe(0o600);
    store.close();
  });

  it("rejects traversal paths, oversized files, and unsupported image contents", async () => {
    const directory = temporaryDirectory();
    const store = new TelegramImageStore(
      directory,
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      60_000,
      async () => ({ stream: Readable.from([Buffer.from("not an image")]) }),
    );
    await store.start();

    await expect(store.download(
      { getFile: async () => ({ file_path: "../secret" }) },
      "file-id",
    )).rejects.toThrow("无效的图片路径");
    await expect(store.download(
      { getFile: async () => ({ file_path: "documents/file.bin" }) },
      "file-id",
    )).rejects.toThrow("仅支持 PNG 和 JPEG");

    const oversized = new TelegramImageStore(
      join(directory, "oversized"),
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      60_000,
      async () => ({
        stream: Readable.from([]),
        contentLength: maximumTelegramImageBytes + 1,
      }),
    );
    await oversized.start();
    await expect(oversized.download(
      { getFile: async () => ({ file_path: "photos/file.jpg" }) },
      "file-id",
    )).rejects.toThrow("超过 10 MiB");
    store.close();
    oversized.close();
  });

  it("does not expose the Bot token in download errors", async () => {
    const directory = temporaryDirectory();
    const store = new TelegramImageStore(
      directory,
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      60_000,
      async () => {
        throw new Error("failed https://api.telegram.org/file/bot123:secret-token/file.jpg");
      },
    );
    await store.start();

    await expect(store.download(
      { getFile: async () => ({ file_path: "photos/file.jpg" }) },
      "file-id",
    )).rejects.toThrow("连接 Telegram 图片服务器失败");
    await expect(store.download(
      { getFile: async () => { throw new Error("123:secret-token"); } },
      "file-id",
    )).rejects.toThrow("无法从 Telegram 获取图片下载信息");
    store.close();
  });

  it("removes expired managed images when starting", async () => {
    const directory = temporaryDirectory();
    const expired = join(directory, "00000000-0000-0000-0000-000000000000.jpg");
    writeFileSync(expired, jpegBytes(), { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    utimesSync(expired, old, old);
    const store = new TelegramImageStore(
      directory,
      "123:secret-token",
      undefined,
      pino({ level: "silent" }),
      1,
      async () => ({ stream: Readable.from([]) }),
    );

    await store.start();

    expect(() => statSync(expired)).toThrow();
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-telegram-images-"));
  directories.push(directory);
  return directory;
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]);
}
