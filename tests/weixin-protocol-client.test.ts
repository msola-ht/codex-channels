import { describe, expect, it, vi } from "vitest";

import {
  createWeixinProtocolClient,
  type WeixinProtocolError,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";

describe("WeixinProtocolClient", () => {
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
            item_list: [{ type: 2, image_item: { url: "private" } }],
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
