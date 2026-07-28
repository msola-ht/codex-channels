import {
  createDecipheriv,
  createHash,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createCredentialBackedWeixinClient,
  createWeixinProtocolClient,
  type StoredWeixinCredential,
  type WeixinCredentialStore,
  type WeixinProtocolError,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";

describe("WeixinProtocolClient", () => {
  it("loads the secure credential once and keeps it out of runtime config", async () => {
    const credential: StoredWeixinCredential = {
      version: 1,
      accountId,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
      grantedAt: 1,
    };
    const store: WeixinCredentialStore = {
      get: vi.fn(async () => credential),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const getUpdates = vi.fn(async () => ({
      cursor: "next",
      messages: [],
    }));
    const sendText = vi.fn(async () => {});
    const sendImage = vi.fn(async () => {});
    const getTypingTicket = vi.fn(async () => "typing-ticket");
    const setTyping = vi.fn(async () => {});
    const createClient = vi.fn(() => ({
      getUpdates,
      sendText,
      sendImage,
      getTypingTicket,
      setTyping,
    }));
    const client = createCredentialBackedWeixinClient({
      accountId,
      credentialStore: store,
      createClient,
    });

    await client.getUpdates("current");
    await client.sendText({
      actorId,
      contextToken: "context",
      text: "reply",
    });
    await client.sendImage({
      actorId,
      contextToken: "context",
      image: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    await client.getTypingTicket({
      actorId,
      contextToken: "context",
    });
    await client.setTyping({
      actorId,
      typingTicket: "typing-ticket",
      status: "typing",
    });

    expect(store.get).toHaveBeenCalledOnce();
    expect(store.get).toHaveBeenCalledWith(accountId);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      accountId,
      baseUrl: credential.baseUrl,
      botToken: credential.botToken,
    });
  });

  it("fails closed when the configured account has no secure credential", async () => {
    const store: WeixinCredentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const client = createCredentialBackedWeixinClient({
      accountId,
      credentialStore: store,
    });

    await expect(client.getUpdates("")).rejects.toThrow(
      "微信加密凭据不存在",
    );
    await expect(client.getUpdates("")).rejects.toThrow(
      "微信加密凭据不存在",
    );
    expect(store.get).toHaveBeenCalledOnce();
  });

  it("parses exact message IDs and sends the fixed getupdates contract", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        longpolling_timeout_ms: 35_000,
        msgs: [{
          message_id: "9007199254740993",
          from_user_id: actorId,
          to_user_id: accountId,
          create_time_ms: 1_700_000_000_000,
          message_type: 1,
          message_state: 2,
          context_token: "context-secret",
          item_list: [{
            type: 1,
            text_item: {
              text: 'hello "message_id":123',
            },
          }],
        }],
      }), { status: 200 }));
    const client = createClient({
      fetchImpl,
      randomBytesImpl: () => Buffer.from([0, 0, 0, 1]),
    });

    await expect(client.getUpdates("current-cursor")).resolves.toEqual({
      cursor: "next-cursor",
      suggestedTimeoutMs: 35_000,
      messages: [{
        kind: "text",
        messageId: "9007199254740993",
        actorId,
        conversationId: actorId,
        contextToken: "context-secret",
        text: 'hello "message_id":123',
        createdAt: 1_700_000_000_000,
      }],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ilinkai.weixin.qq.com/ilink/bot/getupdates",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer bot-secret",
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": "MQ==",
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": "132102",
        },
        body: JSON.stringify({
          get_updates_buf: "current-cursor",
          base_info: {
            channel_version: "2.4.6",
            bot_agent: "CodexConnect/0.145.0",
          },
        }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("extracts bounded quoted text from a Weixin ref_msg", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("7", {
          item_list: [{
            type: 1,
            text_item: { text: "这句话是什么意思？" },
            ref_msg: {
              title: "小马",
              message_item: {
                type: 1,
                text_item: { text: "原始消息" },
              },
            },
          }],
        })],
      }), { status: 200 })),
    });

    await expect(client.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "text",
        text: "这句话是什么意思？",
        quotedText: "小马 | 原始消息",
      }],
    });
  });

  it("preserves the exact referenced message ID from a Weixin ref_msg", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("8", {
          item_list: [{
            type: 1,
            text_item: { text: "引用测试" },
            ref_msg: {
              message_item: {
                type: 0,
                msg_id: "9007199254740993123",
                button_item_list: [],
              },
            },
          }],
        })],
      }), { status: 200 })),
    });

    await expect(client.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "text",
        text: "引用测试",
        quotedMessageId: "9007199254740993123",
      }],
    });
  });

  it("classifies unsupported messages without exposing their content", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [
          message("1", { message_type: 2 }),
          message("2", { message_state: 1 }),
          message("3", { to_user_id: "other@im.bot" }),
          message("4", { context_token: undefined }),
          message("5", {
            item_list: [{ type: 3, voice_item: { text: "private" } }],
          }),
          message("6", {
            item_list: [{ type: 1, text_item: { text: "   " } }],
          }),
        ],
      }), { status: 200 })),
    });

    const result = await client.getUpdates("");

    expect(result.messages).toEqual([
      { kind: "ignored", messageId: "1", reason: "unsupported-message-type" },
      { kind: "ignored", messageId: "2", reason: "unfinished" },
      { kind: "ignored", messageId: "3", reason: "wrong-recipient" },
      { kind: "ignored", messageId: "4", reason: "missing-context" },
      { kind: "ignored", messageId: "5", reason: "unsupported-content" },
      { kind: "ignored", messageId: "6", reason: "unsupported-content" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("parses one fixed v2.4.6 image reference without coercing the message ID", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("9007199254740993", {
          item_list: [{
            type: 2,
            image_item: {
              aeskey: "00112233445566778899aabbccddeeff",
              media: {
                full_url:
                  "https://novac2c.cdn.weixin.qq.com/c2c/download?secret",
                encrypt_query_param: "private-query",
                aes_key: "private-fallback-key",
              },
            },
          }],
        })],
      }), { status: 200 })),
    });

    await expect(client.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "image",
        messageId: "9007199254740993",
        actorId,
        conversationId: actorId,
        contextToken: "context-secret",
        images: [{
          fullUrl:
            "https://novac2c.cdn.weixin.qq.com/c2c/download?secret",
          encryptedQueryParam: "private-query",
          imageAesKey: "00112233445566778899aabbccddeeff",
          mediaAesKey: "private-fallback-key",
        }],
      }],
    });
  });

  it("parses mixed text and multiple images as one inbound message", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("8", {
          item_list: [
            { type: 1, text_item: { text: "比较这两张图" } },
            {
              type: 2,
              image_item: {
                aeskey: "00112233445566778899aabbccddeeff",
                media: { encrypt_query_param: "first-private-query" },
              },
            },
            {
              type: 2,
              image_item: {
                media: {
                  full_url:
                    "https://novac2c.cdn.weixin.qq.com/c2c/download?second",
                  aes_key: "second-private-key",
                },
              },
            },
          ],
        })],
      }), { status: 200 })),
    });

    await expect(client.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "image",
        messageId: "8",
        text: "比较这两张图",
        images: [
          {
            encryptedQueryParam: "first-private-query",
            imageAesKey: "00112233445566778899aabbccddeeff",
          },
          {
            fullUrl:
              "https://novac2c.cdn.weixin.qq.com/c2c/download?second",
            mediaAesKey: "second-private-key",
          },
        ],
      }],
    });
  });

  it("parses one fixed v2.4.6 general file reference", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("9007199254740994", {
          item_list: [{
            type: 4,
            file_item: {
              file_name: "settings.json",
              len: "4177",
              md5: "00112233445566778899aabbccddeeff",
              media: {
                full_url:
                  "https://novac2c.cdn.weixin.qq.com/c2c/download?secret",
                encrypt_query_param: "private-query",
                aes_key: "private-media-key",
              },
            },
          }],
        })],
      }), { status: 200 })),
    });

    await expect(client.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "file",
        messageId: "9007199254740994",
        actorId,
        conversationId: actorId,
        contextToken: "context-secret",
        file: {
          fileName: "settings.json",
          declaredLength: "4177",
          declaredMd5: "00112233445566778899aabbccddeeff",
          fullUrl:
            "https://novac2c.cdn.weixin.qq.com/c2c/download?secret",
          encryptedQueryParam: "private-query",
          mediaAesKey: "private-media-key",
        },
      }],
    });
  });

  it("fails closed on malformed media, excessive images, and mixed media", async () => {
    const malformed = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("7", {
          item_list: [{ type: 2, image_item: { media: {} } }],
        })],
      }), { status: 200 })),
    });
    await expect(malformed.getUpdates("")).rejects.toMatchObject({
      code: "invalid-response",
    });

    const malformedFile = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("7", {
          item_list: [{
            type: 4,
            file_item: {
              file_name: "private.txt",
              media: {},
            },
          }],
        })],
      }), { status: 200 })),
    });
    await expect(malformedFile.getUpdates("")).rejects.toMatchObject({
      code: "invalid-response",
    });

    const excessive = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("8", {
          item_list: Array.from({ length: 5 }, (_, index) => ({
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: `private-query-${index}`,
              },
            },
          })),
        })],
      }), { status: 200 })),
    });
    await expect(excessive.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "ignored",
        messageId: "8",
        reason: "unsupported-content",
      }],
    });

    const mixedMedia = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("9", {
          item_list: [
            {
              type: 2,
              image_item: {
                media: { encrypt_query_param: "private-query" },
              },
            },
            { type: 4, file_item: { file_name: "private.txt" } },
          ],
        })],
      }), { status: 200 })),
    });
    await expect(mixedMedia.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "ignored",
        messageId: "9",
        reason: "unsupported-content",
      }],
    });

    const repeatedText = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: "next-cursor",
        msgs: [message("10", {
          item_list: [
            { type: 1, text_item: { text: "first" } },
            { type: 1, text_item: { text: "second" } },
            {
              type: 2,
              image_item: {
                media: { encrypt_query_param: "private-query" },
              },
            },
          ],
        })],
      }), { status: 200 })),
    });
    await expect(repeatedText.getUpdates("")).resolves.toMatchObject({
      messages: [{
        kind: "ignored",
        messageId: "10",
        reason: "unsupported-content",
      }],
    });
  });

  it("fails closed on malformed message IDs and response fields", async () => {
    const invalidId = createClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "cursor",
        msgs: [message("not-a-number")],
      }), { status: 200 })),
    });
    await expect(invalidId.getUpdates("")).rejects.toMatchObject({
      code: "invalid-response",
    });

    const nonIntegerId = createClient({
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({
          ret: 0,
          get_updates_buf: "cursor",
          msgs: [message("1000")],
        }).replace('"message_id":"1000"', '"message_id":1e3'),
        { status: 200 },
      )),
    });
    await expect(nonIntegerId.getUpdates("")).rejects.toMatchObject({
      code: "invalid-response",
    });

    const invalidCursor = createClient({
      fetchImpl: vi.fn(async () => new Response(exactMessageIds({
        ret: 0,
        get_updates_buf: 123,
        msgs: [],
      }), { status: 200 })),
    });
    await expect(invalidCursor.getUpdates("")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("sends a completed text message with an independent client ID", async () => {
    let randomCall = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("{}", { status: 200 }));
    const client = createClient({
      fetchImpl,
      nowImpl: () => 1_700_000_000_000,
      randomBytesImpl: () => {
        randomCall += 1;
        return randomCall === 1
          ? Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])
          : Buffer.from([0, 0, 0, 1]);
      },
    });

    await expect(client.sendText({
      actorId,
      contextToken: "context-secret",
      text: "reply",
    })).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer bot-secret",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": "MQ==",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "132102",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: actorId,
        client_id: "codex-connect:1700000000000-aabbccdd",
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 1,
          text_item: { text: "reply" },
        }],
        context_token: "context-secret",
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexConnect/0.145.0",
      },
    });
  });

  it("enforces the verified 4000-character outbound boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createClient({ fetchImpl });

    await expect(client.sendText({
      actorId,
      contextToken: "context-secret",
      text: "测".repeat(4_001),
    })).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads and sends one fixed v2.4.6 PNG image contract", async () => {
    const image = Buffer.from([
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
    const aesKey = Buffer.from(
      "00112233445566778899aabbccddeeff",
      "hex",
    );
    const fileKey = Buffer.from(
      "ffeeddccbbaa99887766554433221100",
      "hex",
    );
    const randomValues = [
      aesKey,
      fileKey,
      Buffer.from([0, 0, 0, 1]),
      Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
      Buffer.from([0, 0, 0, 2]),
    ];
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
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = createClient({
      fetchImpl,
      nowImpl: () => 1_700_000_000_000,
      randomBytesImpl: (length) => {
        const value = randomValues.shift();
        expect(value).toHaveLength(length);
        return value!;
      },
    });

    await expect(client.sendImage({
      actorId,
      contextToken: "context-secret",
      image,
    })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [uploadUrl, uploadInit] = fetchImpl.mock.calls[0]!;
    expect(uploadUrl).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl",
    );
    expect(JSON.parse(String(uploadInit?.body))).toEqual({
      filekey: fileKey.toString("hex"),
      media_type: 1,
      to_user_id: actorId,
      rawsize: image.length,
      rawfilemd5: createHash("md5").update(image).digest("hex"),
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
    const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
    expect(Buffer.concat([
      decipher.update(Buffer.from(cdnInit?.body as Uint8Array)),
      decipher.final(),
    ])).toEqual(image);

    const [sendUrl, sendInit] = fetchImpl.mock.calls[2]!;
    expect(sendUrl).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
    );
    expect(JSON.parse(String(sendInit?.body))).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: actorId,
        client_id: "codex-connect:1700000000000-aabbccdd",
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "private-download-param",
              aes_key: Buffer.from(aesKey.toString("hex"))
                .toString("base64"),
              encrypt_type: 1,
            },
            mid_size: 16,
          },
        }],
        context_token: "context-secret",
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexConnect/0.145.0",
      },
    });
  });

  it("rejects invalid image bytes and non-official upload URLs", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createClient({ fetchImpl });
    await expect(client.sendImage({
      actorId,
      contextToken: "context-secret",
      image: Buffer.from("not-an-image"),
    })).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const foreignFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        upload_full_url: "https://example.com/c2c/upload?private=upload",
      }), { status: 200 }));
    await expect(createClient({
      fetchImpl: foreignFetch,
      randomBytesImpl: (length) => Buffer.alloc(length, 1),
    }).sendImage({
      actorId,
      contextToken: "context-secret",
      image: Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]),
    })).rejects.toMatchObject({ code: "invalid-response" });
    expect(foreignFetch).toHaveBeenCalledOnce();
  });

  it("falls back from an empty full URL to the fixed CDN upload parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        upload_full_url: "",
        upload_param: "private upload/+",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "private-download-param" },
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await createClient({
      fetchImpl,
      randomBytesImpl: (length) => Buffer.alloc(length, 1),
    }).sendImage({
      actorId,
      contextToken: "context-secret",
      image: Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]),
    });

    const cdnUrl = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(cdnUrl.origin).toBe("https://novac2c.cdn.weixin.qq.com");
    expect(cdnUrl.pathname).toBe("/c2c/upload");
    expect(cdnUrl.searchParams.get("encrypted_query_param")).toBe(
      "private upload/+",
    );
    expect(cdnUrl.searchParams.get("filekey")).toBe(
      "01010101010101010101010101010101",
    );
  });

  it("retries missing CDN download parameters but stops on 4xx", async () => {
    const image = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);
    const uploadAddress = new Response(JSON.stringify({
      ret: 0,
      upload_full_url:
        "https://novac2c.cdn.weixin.qq.com/c2c/upload?private=upload",
    }), { status: 200 });
    const retryFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(uploadAddress)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "private-download-param" },
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(createClient({
      fetchImpl: retryFetch,
      randomBytesImpl: (length) => Buffer.alloc(length, 1),
    }).sendImage({
      actorId,
      contextToken: "context-secret",
      image,
    })).resolves.toBeUndefined();
    expect(retryFetch).toHaveBeenCalledTimes(5);

    const clientErrorFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        upload_full_url:
          "https://novac2c.cdn.weixin.qq.com/c2c/upload?private=upload",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(createClient({
      fetchImpl: clientErrorFetch,
      randomBytesImpl: (length) => Buffer.alloc(length, 1),
    }).sendImage({
      actorId,
      contextToken: "context-secret",
      image,
    })).rejects.toMatchObject({ code: "http-error", status: 403 });
    expect(clientErrorFetch).toHaveBeenCalledTimes(2);
  });

  it("gets a private typing ticket and sends typing lifecycle states", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        typing_ticket: "private-ticket",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = createClient({
      fetchImpl,
      randomBytesImpl: () => Buffer.from([0, 0, 0, 1]),
    });

    await expect(client.getTypingTicket({
      actorId,
      contextToken: "context-secret",
    })).resolves.toBe("private-ticket");
    await client.setTyping({
      actorId,
      typingTicket: "private-ticket",
      status: "typing",
    });
    await client.setTyping({
      actorId,
      typingTicket: "private-ticket",
      status: "cancel",
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ilinkai.weixin.qq.com/ilink/bot/getconfig",
      "https://ilinkai.weixin.qq.com/ilink/bot/sendtyping",
      "https://ilinkai.weixin.qq.com/ilink/bot/sendtyping",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      ilink_user_id: actorId,
      context_token: "context-secret",
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexConnect/0.145.0",
      },
    });
    expect(
      fetchImpl.mock.calls.slice(1).map(([, init]) =>
        JSON.parse(String(init?.body)).status),
    ).toEqual([1, 2]);
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(
      "private upstream",
    );
  });

  it("fails closed when getconfig omits the typing ticket", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ ret: 0 }), { status: 200 })),
    });

    await expect(client.getTypingTicket({
      actorId,
      contextToken: "context-secret",
    })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects an invalid runtime typing state before the network", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createClient({ fetchImpl });

    await expect(client.setTyping({
      actorId,
      typingTicket: "private-ticket",
      // @ts-expect-error Runtime input remains validated at the boundary.
      status: "unknown",
    })).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes invalid account, URL, and actor inputs", async () => {
    expect(() => createClient({
      baseUrl: "http://example.com",
    })).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => createClient({
      accountId: "invalid-account",
    })).toThrow(expect.objectContaining({ code: "invalid-input" }));

    const client = createClient({ fetchImpl: vi.fn<typeof fetch>() });
    await expect(client.sendText({
      actorId: "invalid-actor",
      contextToken: "context-secret",
      text: "reply",
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("returns constrained HTTP and API errors without upstream text", async () => {
    const httpClient = createClient({
      fetchImpl: vi.fn(async () =>
        new Response("private upstream body", { status: 403 })),
    });
    const httpError = await caught(httpClient.getUpdates(""));
    expect(httpError).toMatchObject({ code: "http-error", status: 403 });
    expect(httpError.message).not.toContain("private");

    const apiClient = createClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ret: -14,
        errmsg: "private session detail",
      }), { status: 200 })),
    });
    const apiError = await caught(apiClient.getUpdates(""));
    expect(apiError).toMatchObject({
      code: "api-error",
      returnCode: -14,
    });
    expect(apiError.message).not.toContain("private");
  });

  it("rejects oversized response bodies before parsing", async () => {
    const client = createClient({
      fetchImpl: vi.fn(async () => new Response("{}", {
        status: 200,
        headers: { "Content-Length": "1048577" },
      })),
    });

    await expect(client.getUpdates("")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("distinguishes timeout and external cancellation", async () => {
    const client = createClient({
      fetchImpl: abortableFetch(),
      getUpdatesTimeoutMs: 1,
    });
    await expect(client.getUpdates("")).rejects.toMatchObject({
      code: "timeout",
    });

    const controller = new AbortController();
    const pending = client.getUpdates("", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

function createClient(
  overrides: Partial<Parameters<typeof createWeixinProtocolClient>[0]> = {},
) {
  return createWeixinProtocolClient({
    accountId,
    baseUrl: "https://ilinkai.weixin.qq.com",
    botToken: "bot-secret",
    ...overrides,
  });
}

function message(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    message_id: id,
    from_user_id: actorId,
    to_user_id: accountId,
    message_type: 1,
    message_state: 2,
    context_token: "context-secret",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    ...overrides,
  };
}

function exactMessageIds(value: unknown): string {
  return JSON.stringify(value).replace(
    /"message_id":"(\d+)"/gu,
    '"message_id":$1',
  );
}

function abortableFetch(): typeof fetch {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener("abort", abort, { once: true });
    }));
}

async function caught(
  promise: Promise<unknown>,
): Promise<WeixinProtocolError> {
  try {
    await promise;
  } catch (error) {
    return error as WeixinProtocolError;
  }
  throw new Error("expected promise to reject");
}
