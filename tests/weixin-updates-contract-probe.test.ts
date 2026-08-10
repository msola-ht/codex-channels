import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as weixinUpdatesContractProbe from "../scripts/weixin-updates-contract-probe.mjs";

const {
  createWeixinUpdatesContractClient,
  runWeixinUpdatesReplaySequence,
  runWeixinUpdatesSequence,
  summarizeResponse,
} = weixinUpdatesContractProbe;

describe("Weixin getupdates contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-updates-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [probePath, "once"], {
      encoding: "utf8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("once --live");
    expect(help.stdout).toContain("replay --live");
    expect(help.stdout).toContain("不保存消息或游标");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
  });

  it("sends the fixed v2.4.6 getupdates wire contract", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ret: 0,
      msgs: [],
      get_updates_buf: "next-secret-cursor",
      longpolling_timeout_ms: 35_000,
    }));
    const client = createWeixinUpdatesContractClient({
      fetchImpl,
      timeoutMs: 1_000,
      randomBytesImpl: () => Buffer.from([0, 0, 0, 1]),
    });

    await expect(client.pollOnce({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
    })).resolves.toEqual({
      kind: "success",
      messageCount: 0,
      hasNextCursor: true,
      suggestedTimeoutMs: 35_000,
      messages: [],
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
          get_updates_buf: "",
          base_info: {
            channel_version: "2.4.6",
            bot_agent: "CodexConnect/0.147.0",
          },
        }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("reports message structure without retaining sensitive fields", () => {
    const raw = JSON.stringify({
      ret: 0,
      msgs: [{
        message_id: 123,
        from_user_id: "private-user@im.wechat",
        to_user_id: "private-bot@im.bot",
        message_type: 1,
        message_state: 2,
        context_token: "context-secret",
        item_list: [{
          type: 1,
          text_item: {
            text: 'private message body with "message_id":123',
          },
        }],
      }],
      get_updates_buf: "cursor-secret",
    }).replace('"message_id":123', '"message_id":9007199254740993');

    const result = summarizeResponse(raw);

    expect(result).toEqual({
      kind: "success",
      messageCount: 1,
      hasNextCursor: true,
      messages: [{
        fromUserShape: "wechat-user",
        messageType: 1,
        messageState: 2,
        itemTypes: [1],
        hasContextToken: true,
        messageIdDigits: 16,
        messageIdSafeInteger: false,
      }],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("9007199254740993");
  });

  it("reports quoted structure without retaining quoted text", () => {
    const result = summarizeResponse(JSON.stringify({
      ret: 0,
      msgs: [{
        message_id: 123,
        from_user_id: "private-user@im.wechat",
        message_type: 1,
        message_state: 2,
        context_token: "context-secret",
        item_list: [{
          type: 1,
          text_item: { text: "current private body" },
          ref_msg: {
            title: "private author",
            message_item: {
              type: 1,
              msg_id: "codex-connect:1785210000000-0123abcd",
              text_item: { text: "quoted private body" },
            },
          },
        }],
      }],
      get_updates_buf: "cursor-secret",
    }));

    expect(result.messages[0]).toMatchObject({
      references: [{
        referenceFields: ["message_item", "title"],
        hasTitle: true,
        referencedItemFields: ["msg_id", "text_item", "type"],
        referencedMessageIdShape: "codex-connect-client",
        referencedItemType: 1,
        hasReferencedText: true,
      }],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails closed on malformed message lists and IDs", () => {
    expect(() => summarizeResponse(JSON.stringify({
      ret: 0,
      msgs: [{ from_user_id: "actor@im.wechat" }],
    }))).toThrow(expect.objectContaining({ code: "invalid-response" }));
    expect(() => summarizeResponse(JSON.stringify({
      ret: 0,
      msgs: "invalid",
    }))).toThrow(expect.objectContaining({ code: "invalid-response" }));
  });

  it("returns only stable API error codes without upstream text", () => {
    const result = summarizeResponse(JSON.stringify({
      ret: -14,
      errcode: -14,
      errmsg: "upstream secret detail",
    }));

    expect(result).toEqual({
      kind: "api-error",
      ret: -14,
      errorCode: -14,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("distinguishes timeout and external cancellation", async () => {
    const client = createWeixinUpdatesContractClient({
      fetchImpl: abortableFetch(),
      timeoutMs: 1,
    });
    await expect(client.pollOnce({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
    })).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const pending = client.pollOnce({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("keeps cursors private while comparing two poll responses", async () => {
    const responses = [
      {
        ret: 0,
        get_updates_buf: "cursor-one",
        msgs: [message(9007199254740993n)],
      },
      {
        ret: 0,
        get_updates_buf: "cursor-two",
        msgs: [
          message(9007199254740993n),
          message(9007199254740995n),
        ],
      },
    ];
    const client = createWeixinUpdatesContractClient({
      fetchImpl: vi.fn(async () =>
        new Response(jsonWithExactIds(responses.shift()!), {
          status: 200,
        })),
    });

    const result = await runWeixinUpdatesSequence({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
    });

    expect(result).toMatchObject({
      cursorAdvanced: true,
      replayedMessageCount: 1,
      first: { messageCount: 1 },
      second: { messageCount: 2 },
    });
    expect(JSON.stringify(result)).not.toContain("cursor-");
    expect(JSON.stringify(result)).not.toContain("900719925");
  });

  it("reuses the old cursor to measure second-batch replay without exposing IDs", async () => {
    const responses = [
      {
        ret: 0,
        get_updates_buf: "cursor-one",
        msgs: [message(9007199254740993n)],
      },
      {
        ret: 0,
        get_updates_buf: "cursor-two",
        msgs: [message(9007199254740995n)],
      },
      {
        ret: 0,
        get_updates_buf: "cursor-two",
        msgs: [message(9007199254740995n)],
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(jsonWithExactIds(responses.shift()!), {
        status: 200,
      }));
    const client = createWeixinUpdatesContractClient({ fetchImpl });

    const result = await runWeixinUpdatesReplaySequence({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
    });

    expect(result).toMatchObject({
      cursorAdvanced: true,
      replayedMessageCount: 0,
      thirdTimedOut: false,
      thirdCursorMatchesSecond: true,
      secondBatchReplayCount: 1,
      third: { messageCount: 1 },
    });
    const secondRequest = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body),
    ) as { get_updates_buf: string };
    const thirdRequest = JSON.parse(
      String(fetchImpl.mock.calls[2]?.[1]?.body),
    ) as { get_updates_buf: string };
    expect(thirdRequest.get_updates_buf).toBe(secondRequest.get_updates_buf);
    expect(JSON.stringify(result)).not.toContain("cursor-");
    expect(JSON.stringify(result)).not.toContain("900719925");
  });

  it("reports an old-cursor replay timeout as a diagnostic result", async () => {
    const client = {
      pollOnce: vi.fn()
        .mockResolvedValueOnce(privateSummary("cursor-one", "1"))
        .mockResolvedValueOnce(privateSummary("cursor-two", "2"))
        .mockRejectedValueOnce(
          new weixinUpdatesContractProbe.WeixinUpdatesContractError(
            "timeout",
            "timeout",
          ),
        ),
    };

    await expect(runWeixinUpdatesReplaySequence({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
    })).resolves.toMatchObject({
      thirdTimedOut: true,
      secondBatchReplayCount: 0,
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

function message(id: bigint) {
  return {
    message_id: id.toString(),
    from_user_id: "actor@im.wechat",
    message_type: 1,
    message_state: 2,
    context_token: "secret",
    item_list: [{ type: 1 }],
  };
}

function jsonWithExactIds(value: unknown): string {
  return JSON.stringify(value).replace(
    /"message_id":"(\d+)"/gu,
    '"message_id":$1',
  );
}

function privateSummary(cursor: string, id: string) {
  const raw = JSON.stringify({
    ret: 0,
    get_updates_buf: cursor,
    msgs: [message(BigInt(id))],
  }).replace(/"message_id":"(\d+)"/gu, '"message_id":$1');
  return summarizeResponseWithPrivateMetadata(raw);
}

async function summarizeResponseWithPrivateMetadata(raw: string) {
  const client = createWeixinUpdatesContractClient({
    fetchImpl: vi.fn(async () => new Response(raw, { status: 200 })),
  });
  return client.pollOnce({
    baseUrl: "https://ilinkai.weixin.qq.com",
    botToken: "bot-secret",
  });
}
