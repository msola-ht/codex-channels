import { createCipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as imageProbe from "../scripts/weixin-image-contract-probe.mjs";
// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as updatesProbe from "../scripts/weixin-updates-contract-probe.mjs";

const {
  createWeixinImageContractClient,
  runWeixinImageDownloadContract,
} = imageProbe;
const { createWeixinUpdatesContractClient } = updatesProbe;

describe("Weixin image contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-image-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [probePath, "download"], {
      encoding: "utf8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("download --live");
    expect(help.stdout).toContain("不保存图片或密钥");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
  });

  it("downloads and decrypts the fixed v2.4.6 image contract in memory", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("private-image-body"),
    ]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-length": String(encrypted.length) },
      }));
    const imageClient = createWeixinImageContractClient({
      fetchImpl,
      timeoutMs: 1_000,
    });

    const result = await runWeixinImageDownloadContract({
      updatesClient: createImageUpdatesClient({
        aeskey: key.toString("hex"),
        media: { encrypt_query_param: "private-query" },
      }),
      imageClient,
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(
        "https://novac2c.cdn.weixin.qq.com/c2c/download"
        + "?encrypted_query_param=private-query",
      ),
      {
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
    expect(result).toMatchObject({
      inbound: {
        kind: "success",
        messageCount: 1,
        messages: [{ itemTypes: [2] }],
      },
      download: {
        kind: "success",
        urlSource: "query-param",
        encryption: "image-hex",
        downloadedBytes: encrypted.length,
        imageBytes: plaintext.length,
        mimeType: "image/png",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-query");
    expect(serialized).not.toContain(key.toString("hex"));
    expect(serialized).not.toContain("allowed-user");
    expect(serialized).not.toContain("bot-secret");
  });

  it("accepts the official media Base64 key fallback and full CDN URL", async () => {
    const key = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(encrypted, { status: 200 }));
    const client = createWeixinImageContractClient({ fetchImpl });

    await expect(client.download({
      fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?id=secret",
      mediaAesKey: Buffer.from(key.toString("hex"), "ascii").toString("base64"),
    })).resolves.toMatchObject({
      urlSource: "full-url",
      encryption: "media-base64",
      mimeType: "image/jpeg",
    });
  });

  it("fails closed on non-official URLs, invalid keys and unsupported bytes", async () => {
    const client = createWeixinImageContractClient({
      fetchImpl: vi.fn(async () =>
        new Response(Buffer.from("not-an-image"), { status: 200 })),
    });

    await expect(client.download({
      fullUrl: "https://example.com/c2c/download",
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.download({
      encryptedQueryParam: "query",
      imageAesKey: "invalid",
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.download({
      encryptedQueryParam: "query",
    })).rejects.toMatchObject({ code: "unsupported-image" });
  });

  it("enforces the image size limit from headers before reading the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024 + 1) },
      }));
    const client = createWeixinImageContractClient({ fetchImpl });

    await expect(client.download({
      encryptedQueryParam: "query",
    })).rejects.toMatchObject({ code: "too-large" });
  });
});

function createImageUpdatesClient(imageItem: Record<string, unknown>) {
  return createWeixinUpdatesContractClient({
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      get_updates_buf: "private-cursor",
      msgs: [{
        message_id: 123,
        from_user_id: "allowed-user@im.wechat",
        to_user_id: "bot@im.bot",
        message_type: 1,
        message_state: 2,
        context_token: "private-context",
        item_list: [{
          type: 2,
          image_item: imageItem,
        }],
      }],
    }), { status: 200 })),
  });
}
