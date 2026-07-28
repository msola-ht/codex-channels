import { createCipheriv, createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  maximumWeixinTextFileBytes,
  WeixinFileInput,
} from "../src/surfaces/weixin/index.js";

describe("WeixinFileInput", () => {
  it("downloads, decrypts and verifies a UTF-8 text file without persisting it", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.from("{\n  \"enabled\": true\n}\n");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(encrypted, {
        status: 200,
        headers: { "content-length": String(encrypted.length) },
      }));
    const input = new WeixinFileInput(fetchImpl);

    await expect(input.download({
      fileName: "settings.json",
      declaredLength: String(plaintext.length),
      declaredMd5: createHash("md5").update(plaintext).digest("hex"),
      fullUrl:
        "https://novac2c.cdn.weixin.qq.com/c2c/download?private-query",
      mediaAesKey: Buffer.from(key.toString("hex"), "ascii").toString("base64"),
    })).resolves.toEqual({
      fileName: "settings.json",
      text: plaintext.toString("utf8"),
      bytes: plaintext.length,
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
  });

  it("fails closed on oversized, binary and integrity-mismatched files", async () => {
    const oversized = new WeixinFileInput(vi.fn(async () =>
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: {
          "content-length": String(maximumWeixinTextFileBytes + 17),
        },
      })));
    await expect(oversized.download(reference())).rejects.toMatchObject({
      code: "too-large",
    });

    const binaryPlaintext = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const binary = encryptedInput(binaryPlaintext);
    await expect(binary.input.download({
      ...reference(),
      mediaAesKey: binary.encodedKey,
    })).rejects.toMatchObject({ code: "unsupported" });

    const mismatched = encryptedInput(Buffer.from("valid text"));
    await expect(mismatched.input.download({
      ...reference(),
      mediaAesKey: mismatched.encodedKey,
      declaredMd5: "00000000000000000000000000000000",
    })).rejects.toMatchObject({ code: "integrity" });
  });
});

function reference() {
  return {
    fileName: "fixture.txt",
    encryptedQueryParam: "private-query",
  };
}

function encryptedInput(plaintext: Buffer): {
  input: WeixinFileInput;
  encodedKey: string;
} {
  const key = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    input: new WeixinFileInput(vi.fn(async () =>
      new Response(encrypted, { status: 200 }))),
    encodedKey: key.toString("base64"),
  };
}
