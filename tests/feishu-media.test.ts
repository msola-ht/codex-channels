import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserFacingError } from "../src/conversation-core/index.js";
import {
  FeishuImageStore,
  maximumFeishuImageBytes,
} from "../src/surfaces/feishu/media.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FeishuImageStore", () => {
  it("downloads and stores a private JPEG from a message resource", async () => {
    const directory = temporaryDirectory();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const downloadImage = vi.fn(async () => ({
      stream: Readable.from([bytes]),
      contentLength: bytes.length,
    }));
    const store = new FeishuImageStore(
      directory,
      { downloadImage },
      pino({ level: "silent" }),
    );

    const image = await store.download("om_message", "img_v2_resource");

    expect(downloadImage).toHaveBeenCalledWith(
      "om_message",
      "img_v2_resource",
    );
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.bytes).toBe(bytes.length);
    expect(readFileSync(image.path)).toEqual(bytes);
    expect(statSync(image.path).mode & 0o777).toBe(0o600);
    store.close();
  });

  it("rejects oversized and unsupported resources with structured errors", async () => {
    const oversized = new FeishuImageStore(
      temporaryDirectory(),
      {
        downloadImage: async () => ({
          stream: Readable.from([]),
          contentLength: maximumFeishuImageBytes + 1,
        }),
      },
      pino({ level: "silent" }),
    );
    await oversized.start();
    await expect(
      oversized.download("om_message", "img_large"),
    ).rejects.toEqual(new UserFacingError(
      "image.too-large",
      "图片超过 10 MiB 限制",
    ));
    oversized.close();

    const unsupported = new FeishuImageStore(
      temporaryDirectory(),
      {
        downloadImage: async () => ({
          stream: Readable.from([Buffer.from("not an image")]),
        }),
      },
      pino({ level: "silent" }),
    );
    await unsupported.start();
    await expect(
      unsupported.download("om_message", "img_text"),
    ).rejects.toEqual(new UserFacingError(
      "image.unsupported",
      "仅支持 PNG 和 JPEG 图片",
    ));
    unsupported.close();
  });

  it("does not expose SDK download error details", async () => {
    const store = new FeishuImageStore(
      temporaryDirectory(),
      {
        downloadImage: async () => {
          throw new Error("Authorization: secret");
        },
      },
      pino({ level: "silent" }),
    );
    await store.start();

    await expect(
      store.download("om_message", "img_secret"),
    ).rejects.toThrow("下载飞书图片失败");
    await expect(
      store.download("om_message", "img_secret"),
    ).rejects.not.toThrow("secret");
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-images-"));
  directories.push(directory);
  return directory;
}
