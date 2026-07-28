import { createCipheriv, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as fileProbe from "../scripts/weixin-file-contract-probe.mjs";
// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as updatesProbe from "../scripts/weixin-updates-contract-probe.mjs";

const {
  createWeixinFileContractClient,
  runWeixinFileDownloadContract,
} = fileProbe;
const { createWeixinUpdatesContractClient } = updatesProbe;

describe("Weixin file contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-file-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [probePath, "download"], {
      encoding: "utf8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("download --live");
    expect(help.stdout).toContain("不保存文件、正文或密钥");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
  });

  it("downloads, decrypts and verifies the fixed v2.4.6 file contract in memory", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.from("%PDF-1.7\nprivate-file-body\n");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-length": String(encrypted.length) },
      }));
    const fileClient = createWeixinFileContractClient({
      fetchImpl,
      timeoutMs: 1_000,
    });
    const result = await runWeixinFileDownloadContract({
      updatesClient: createFileUpdatesClient({
        media: {
          aes_key: Buffer.from(key.toString("hex"), "ascii").toString("base64"),
          encrypt_query_param: "private-query",
        },
        file_name: "private-contract.pdf",
        len: String(plaintext.length),
        md5: createHash("md5").update(plaintext).digest("hex"),
      }),
      fileClient,
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
        messages: [{ itemTypes: [4] }],
      },
      download: {
        kind: "success",
        urlSource: "query-param",
        encryption: "media-base64",
        downloadedBytes: encrypted.length,
        fileBytes: plaintext.length,
        declaredBytes: plaintext.length,
        declaredLengthMatches: true,
        hasFileName: true,
        fileNameShape: "basename-with-extension",
        mimeType: "application/pdf",
        mimeSource: "filename-extension",
        hasDeclaredMd5: true,
        md5Matches: true,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-query");
    expect(serialized).not.toContain("private-contract.pdf");
    expect(serialized).not.toContain(key.toString("hex"));
    expect(serialized).not.toContain("allowed-user");
    expect(serialized).not.toContain("bot-secret");
    expect(serialized).not.toContain("private-file-body");
  });

  it("fails closed on non-official URLs, invalid keys and oversized declarations", async () => {
    const client = createWeixinFileContractClient({
      fetchImpl: vi.fn(async () =>
        new Response(Buffer.alloc(16), { status: 200 })),
    });

    await expect(client.download({
      fullUrl: "https://example.com/c2c/download",
      mediaAesKey: Buffer.alloc(16).toString("base64"),
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.download({
      encryptedQueryParam: "query",
      mediaAesKey: "invalid",
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.download({
      encryptedQueryParam: "query",
      mediaAesKey: Buffer.alloc(16).toString("base64"),
      declaredLength: String(20 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({ code: "too-large" });
  });
});

function createFileUpdatesClient(fileItem: Record<string, unknown>) {
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
          type: 4,
          file_item: fileItem,
        }],
      }],
    }), { status: 200 })),
  });
}
