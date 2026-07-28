import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as imageSendProbe from "../scripts/weixin-image-send-contract-probe.mjs";
// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as updatesProbe from "../scripts/weixin-updates-contract-probe.mjs";

const {
  createWeixinImageSendContractClient,
  runWeixinImageSendContract,
  summarizeSendResponse,
} = imageSendProbe;
const { createWeixinUpdatesContractClient } = updatesProbe;
const png = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x01,
]);

describe("Weixin outbound image contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-image-send-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [probePath, "send"], {
      encoding: "utf8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("send --live");
    expect(help.stdout).toContain("停止 Gateway");
    expect(help.stdout).toContain("不会输出或保存图片");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
  });

  it("uses the exact v2.4.6 getuploadurl, CDN and image message shapes", async () => {
    const aesKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const fileKey = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        upload_full_url:
          "https://novac2c.cdn.weixin.qq.com/c2c/upload?private=upload",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "private-download-param" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
      }));
    const randomValues = [
      aesKey,
      fileKey,
      Buffer.from([0, 0, 0, 1]),
      Buffer.from([0, 0, 0, 2]),
      Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
    ];
    const client = createWeixinImageSendContractClient({
      fetchImpl,
      nowImpl: () => 1_700_000_000_000,
      randomBytesImpl: (length: number) => {
        const value = randomValues.shift();
        expect(value).toHaveLength(length);
        return value;
      },
    });

    const result = await client.sendPng({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
      toUserId: "private-user@im.wechat",
      contextToken: "private-context",
      pngBytes: png,
    });

    expect(result).toEqual({
      uploadUrl: { kind: "success", urlSource: "full-url" },
      cdn: {
        kind: "success",
        hasDownloadParam: true,
        ciphertextBytes: 16,
      },
      outbound: { kind: "success", hasReturnCode: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const [uploadApiUrl, uploadApiInit] = fetchImpl.mock.calls[0]!;
    expect(uploadApiUrl).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl",
    );
    expect(uploadApiInit).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer bot-secret",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": "MQ==",
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "132102",
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(uploadApiInit?.body))).toEqual({
      filekey: fileKey.toString("hex"),
      media_type: 1,
      to_user_id: "private-user@im.wechat",
      rawsize: png.length,
      rawfilemd5: createHash("md5").update(png).digest("hex"),
      filesize: 16,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexConnect/0.145.0",
      },
    });

    const [cdnUrl, cdnInit] = fetchImpl.mock.calls[1]!;
    expect(String(cdnUrl)).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/upload?private=upload",
    );
    expect(cdnInit).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    const ciphertext = Buffer.from(cdnInit?.body as Uint8Array);
    const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
    expect(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])).toEqual(png);

    const [sendUrl, sendInit] = fetchImpl.mock.calls[2]!;
    expect(sendUrl).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
    );
    expect(sendInit).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer bot-secret",
        "X-WECHAT-UIN": "Mg==",
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(sendInit?.body))).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "private-user@im.wechat",
        client_id: "codex-connect:1700000000000-aabbccdd",
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "private-download-param",
              aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
              encrypt_type: 1,
            },
            mid_size: 16,
          },
        }],
        context_token: "private-context",
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexConnect/0.145.0",
      },
    });
  });

  it("builds the fixed CDN fallback URL from upload_param and filekey", async () => {
    const fetchImpl = successfulFetchSequence({
      uploadResponse: {
        ret: 0,
        upload_param: "private upload/+",
      },
    });
    const client = createClient(fetchImpl);

    await client.sendPng(validSendInput());

    const cdnUrl = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(cdnUrl.origin).toBe("https://novac2c.cdn.weixin.qq.com");
    expect(cdnUrl.pathname).toBe("/c2c/upload");
    expect(cdnUrl.searchParams.get("encrypted_query_param")).toBe(
      "private upload/+",
    );
    expect(cdnUrl.searchParams.get("filekey")).toBe(
      "11111111111111111111111111111111",
    );
  });

  it("rejects a non-official upload URL before uploading ciphertext", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        upload_full_url: "https://example.com/c2c/upload?private=1",
      }), { status: 200 }));
    const client = createClient(fetchImpl);

    await expect(client.sendPng(validSendInput())).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a missing CDN response parameter but not a client error", async () => {
    const retryFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(uploadApiResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      }))
      .mockResolvedValueOnce(sendApiResponse());

    await expect(createClient(retryFetch).sendPng(
      validSendInput(),
    )).resolves.toMatchObject({
      cdn: { kind: "success" },
      outbound: { kind: "success" },
    });
    expect(retryFetch).toHaveBeenCalledTimes(5);

    const clientErrorFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(uploadApiResponse())
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(createClient(clientErrorFetch).sendPng(
      validSendInput(),
    )).rejects.toMatchObject({ code: "http-error" });
    expect(clientErrorFetch).toHaveBeenCalledTimes(2);
  });

  it("returns stable API status without exposing upstream text", () => {
    const result = summarizeSendResponse(JSON.stringify({
      ret: -14,
      errmsg: "upstream secret detail",
    }));

    expect(result).toEqual({ kind: "api-error", ret: -14 });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(() => summarizeSendResponse("not-json")).toThrow(
      expect.objectContaining({ code: "invalid-response" }),
    );
  });

  it("uses one authorized completed text context only in memory", async () => {
    const updatesClient = createWeixinUpdatesContractClient({
      fetchImpl: vi.fn(async () => new Response(exactUpdatesResponse({
        ret: 0,
        get_updates_buf: "private-cursor",
        msgs: [
          inboundMessage("other-user@im.wechat", "other-context", 1n),
          inboundMessage("allowed-user@im.wechat", "reply-context", 2n),
        ],
      }), { status: 200 })),
    });
    const sendPng = vi.fn(async (input: {
      pngBytes: Buffer;
    }) => {
      expect(input.pngBytes).toBeInstanceOf(Buffer);
      return {
        uploadUrl: { kind: "success", urlSource: "full-url" },
        cdn: {
          kind: "success",
          hasDownloadParam: true,
          ciphertextBytes: 80,
        },
        outbound: { kind: "success", hasReturnCode: true },
      };
    });

    const result = await runWeixinImageSendContract({
      updatesClient,
      imageSendClient: { sendPng },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    });

    expect(sendPng).toHaveBeenCalledWith(expect.objectContaining({
      toUserId: "allowed-user@im.wechat",
      contextToken: "reply-context",
      pngBytes: expect.any(Buffer),
    }));
    const input = sendPng.mock.calls[0]![0];
    expect(input.pngBytes.subarray(0, 8)).toEqual(png.subarray(0, 8));
    expect(input.pngBytes.readUInt32BE(16)).toBe(64);
    expect(input.pngBytes.readUInt32BE(20)).toBe(64);
    expect(result).toMatchObject({
      inbound: { kind: "success", messageCount: 2 },
      uploadUrl: { kind: "success" },
      cdn: { kind: "success" },
      outbound: { kind: "success" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("allowed-user");
    expect(serialized).not.toContain("reply-context");
    expect(serialized).not.toContain("private-cursor");
    expect(serialized).not.toContain("bot-secret");
    expect(serialized).not.toContain("iVBOR");
  });
});

function createClient(fetchImpl: typeof fetch) {
  return createWeixinImageSendContractClient({
    fetchImpl,
    nowImpl: () => 1_700_000_000_000,
    randomBytesImpl: (length: number) =>
      Buffer.alloc(length, length === 16 ? 0x11 : 0x01),
  });
}

function successfulFetchSequence({
  uploadResponse = {
    ret: 0,
    upload_full_url:
      "https://novac2c.cdn.weixin.qq.com/c2c/upload?private=upload",
  },
}: {
  uploadResponse?: Record<string, unknown>;
} = {}) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(uploadResponse), {
      status: 200,
    }))
    .mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: { "x-encrypted-param": "private-download-param" },
    }))
    .mockResolvedValueOnce(sendApiResponse());
}

function uploadApiResponse() {
  return new Response(JSON.stringify({
    ret: 0,
    upload_full_url:
      "https://novac2c.cdn.weixin.qq.com/c2c/upload?private=upload",
  }), { status: 200 });
}

function sendApiResponse() {
  return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
}

function validSendInput() {
  return {
    baseUrl: "https://ilinkai.weixin.qq.com",
    botToken: "bot-secret",
    toUserId: "actor@im.wechat",
    contextToken: "context-secret",
    pngBytes: png,
  };
}

function inboundMessage(userId: string, contextToken: string, id: bigint) {
  return {
    message_id: id.toString(),
    from_user_id: userId,
    message_type: 1,
    message_state: 2,
    context_token: contextToken,
    item_list: [{
      type: 1,
      text_item: { text: "private inbound body" },
    }],
  };
}

function exactUpdatesResponse(value: unknown): string {
  return JSON.stringify(value).replace(
    /"message_id":"(\d+)"/gu,
    '"message_id":$1',
  );
}
