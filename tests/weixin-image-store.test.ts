import { createCipheriv } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  maximumWeixinImageBytes,
  WeixinImageStore,
} from "../src/surfaces/weixin/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WeixinImageStore", () => {
  it("downloads, decrypts and privately stores a fixed CDN PNG", async () => {
    const directory = temporaryDirectory();
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("image"),
    ]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-length": String(encrypted.length) },
      }));
    const store = new WeixinImageStore(
      directory,
      pino({ level: "silent" }),
      fetchImpl,
    );

    const image = await store.download({
      fullUrl:
        "https://novac2c.cdn.weixin.qq.com/c2c/download?private-query",
      imageAesKey: key.toString("hex"),
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(
        "https://novac2c.cdn.weixin.qq.com/c2c/download?private-query",
      ),
      {
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toBe(plaintext.length);
    expect(readFileSync(image.path)).toEqual(plaintext);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(image.path).mode & 0o777).toBe(0o600);
    }
    store.close();
  });

  it("supports the media Base64 key fallback and query-param URL", async () => {
    const key = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(encrypted, { status: 200 }));
    const store = new WeixinImageStore(
      temporaryDirectory(),
      pino({ level: "silent" }),
      fetchImpl,
    );

    await expect(store.download({
      encryptedQueryParam: "private-query",
      mediaAesKey: key.toString("base64"),
    })).resolves.toMatchObject({
      mimeType: "image/jpeg",
      bytes: plaintext.length,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL(
      "https://novac2c.cdn.weixin.qq.com/c2c/download"
      + "?encrypted_query_param=private-query",
    ));
    store.close();
  });

  it("returns structured errors for oversized, unsupported and failed downloads", async () => {
    const oversized = new WeixinImageStore(
      temporaryDirectory(),
      pino({ level: "silent" }),
      vi.fn(async () => new Response(Buffer.alloc(0), {
        status: 200,
        headers: {
          "content-length": String(maximumWeixinImageBytes + 1),
        },
      })),
    );
    await expect(oversized.download({
      encryptedQueryParam: "query",
    })).rejects.toMatchObject({
      code: "image.too-large",
      message: "图片超过 10 MiB 限制",
    });
    oversized.close();

    const unsupported = new WeixinImageStore(
      temporaryDirectory(),
      pino({ level: "silent" }),
      vi.fn(async () => new Response(Buffer.from("not-image"), {
        status: 200,
      })),
    );
    await expect(unsupported.download({
      encryptedQueryParam: "query",
    })).rejects.toMatchObject({
      code: "image.unsupported",
      message: "仅支持 PNG、JPEG、WebP 和非动画 GIF 图片",
    });
    unsupported.close();

    const failed = new WeixinImageStore(
      temporaryDirectory(),
      pino({ level: "silent" }),
      vi.fn(async () => {
        throw new Error("private CDN URL and key");
      }),
    );
    await expect(failed.download({
      encryptedQueryParam: "private-query",
    })).rejects.toMatchObject({
      name: "WeixinImageDownloadError",
      message: "下载微信图片失败，请重新发送",
    });
    await expect(failed.download({
      encryptedQueryParam: "private-query",
    })).rejects.not.toThrow("private");
    failed.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-weixin-images-"));
  directories.push(directory);
  return directory;
}
