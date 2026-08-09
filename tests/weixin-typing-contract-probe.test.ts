import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as typingProbe from "../scripts/weixin-typing-contract-probe.mjs";
// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as updatesProbe from "../scripts/weixin-updates-contract-probe.mjs";

const {
  createWeixinTypingContractClient,
  parseTypingTicketResponse,
  runWeixinTypingLifecycleContract,
  summarizeTypingResponse,
} = typingProbe;
const { createWeixinUpdatesContractClient } = updatesProbe;

describe("Weixin typing contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-typing-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    const rejected = spawnSync(
      process.execPath,
      [probePath, "lifecycle"],
      { encoding: "utf8" },
    );

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("lifecycle --live");
    expect(help.stdout).toContain("不保存输入状态票据");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
  });

  it("uses the fixed v2.4.6 getconfig and sendtyping contracts", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: 0,
        typing_ticket: "private-ticket",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = createWeixinTypingContractClient({
      fetchImpl,
      timeoutMs: 1_000,
      randomBytesImpl: () => Buffer.from([0, 0, 0, 1]),
    });

    await expect(client.getTypingTicket(validTicketInput())).resolves.toEqual({
      kind: "success",
      hasReturnCode: true,
      typingTicket: "private-ticket",
    });
    await expect(client.sendTyping({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
      toUserId: "actor@im.wechat",
      typingTicket: "private-ticket",
      status: 1,
    })).resolves.toEqual({
      kind: "success",
      hasReturnCode: false,
    });

    const [configUrl, configInit] = fetchImpl.mock.calls[0]!;
    expect(configUrl).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/getconfig",
    );
    expect(configInit).toMatchObject({
      method: "POST",
      headers: expectedHeaders(),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(configInit?.body))).toEqual({
      ilink_user_id: "actor@im.wechat",
      context_token: "context-secret",
      base_info: expectedBaseInfo(),
    });

    const [typingUrl, typingInit] = fetchImpl.mock.calls[1]!;
    expect(typingUrl).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendtyping",
    );
    expect(typingInit).toMatchObject({
      method: "POST",
      headers: expectedHeaders(),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(typingInit?.body))).toEqual({
      ilink_user_id: "actor@im.wechat",
      typing_ticket: "private-ticket",
      status: 1,
      base_info: expectedBaseInfo(),
    });
  });

  it("runs start, five-second renewal and cancel without exposing secrets", async () => {
    const updatesClient = createUpdatesClient();
    const waitImpl = vi.fn(
      async (milliseconds: number, signal?: AbortSignal) => {
        void milliseconds;
        void signal;
      },
    );
    const getTypingTicket = vi.fn(async () => ({
      kind: "success",
      hasReturnCode: true,
      typingTicket: "private-ticket",
    }));
    const sendTyping = vi.fn(async (input: { status: number }) => {
      void input;
      return {
        kind: "success",
        hasReturnCode: false,
      };
    });

    const result = await runWeixinTypingLifecycleContract({
      updatesClient,
      typingClient: { getTypingTicket, sendTyping },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
      waitImpl,
    });

    expect(waitImpl.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      5_000,
      3_000,
    ]);
    expect(sendTyping.mock.calls.map(([input]) => input.status)).toEqual([
      1,
      1,
      2,
    ]);
    expect(result).toMatchObject({
      inbound: { kind: "success", messageCount: 1 },
      config: {
        kind: "success",
        hasReturnCode: true,
        hasTypingTicket: true,
      },
      statuses: [
        { status: "typing", result: { kind: "success" } },
        { status: "typing", result: { kind: "success" } },
        { status: "cancel", result: { kind: "success" } },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-ticket");
    expect(serialized).not.toContain("reply-context");
    expect(serialized).not.toContain("allowed-user");
    expect(serialized).not.toContain("bot-secret");
  });

  it("cancels after a failed keepalive and does not wait again", async () => {
    const waitImpl = vi.fn(async () => {});
    const sendTyping = vi.fn()
      .mockResolvedValueOnce({ kind: "success", hasReturnCode: false })
      .mockResolvedValueOnce({ kind: "api-error", ret: -14 })
      .mockResolvedValueOnce({ kind: "success", hasReturnCode: false });

    const result = await runWeixinTypingLifecycleContract({
      updatesClient: createUpdatesClient(),
      typingClient: {
        getTypingTicket: vi.fn(async () => ({
          kind: "success",
          hasReturnCode: false,
          typingTicket: "private-ticket",
        })),
        sendTyping,
      },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
      waitImpl,
    });

    expect(waitImpl).toHaveBeenCalledOnce();
    expect(sendTyping.mock.calls.map(([input]) => input.status)).toEqual([
      1,
      1,
      2,
    ]);
    expect(result.statuses[1]).toEqual({
      status: "typing",
      result: { kind: "api-error", ret: -14 },
    });
    expect(result.statuses[2]).toEqual({
      status: "cancel",
      result: { kind: "success", hasReturnCode: false },
    });
  });

  it("returns only stable API status and fails closed on malformed tickets", () => {
    expect(summarizeTypingResponse(JSON.stringify({
      ret: -14,
      errmsg: "upstream secret detail",
    }))).toEqual({ kind: "api-error", ret: -14 });
    expect(() => parseTypingTicketResponse(JSON.stringify({
      ret: 0,
      typing_ticket: "",
    }))).toThrow(expect.objectContaining({ code: "invalid-response" }));
    expect(() => summarizeTypingResponse("not-json")).toThrow(
      expect.objectContaining({ code: "invalid-response" }),
    );
  });

  it("distinguishes timeout and external cancellation", async () => {
    const client = createWeixinTypingContractClient({
      fetchImpl: abortableFetch(),
      timeoutMs: 1,
    });
    await expect(client.getTypingTicket(validTicketInput())).rejects
      .toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const pending = client.getTypingTicket({
      ...validTicketInput(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

function validTicketInput() {
  return {
    baseUrl: "https://ilinkai.weixin.qq.com",
    botToken: "bot-secret",
    toUserId: "actor@im.wechat",
    contextToken: "context-secret",
  };
}

function expectedHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer bot-secret",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": "MQ==",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132102",
  };
}

function expectedBaseInfo() {
  return {
    channel_version: "2.4.6",
    bot_agent: "CodexConnect/0.146.1",
  };
}

function createUpdatesClient() {
  return createWeixinUpdatesContractClient({
    fetchImpl: vi.fn(async () => new Response(exactUpdatesResponse({
      ret: 0,
      get_updates_buf: "private-cursor",
      msgs: [{
        message_id: "1234567890123456789",
        from_user_id: "allowed-user@im.wechat",
        message_type: 1,
        message_state: 2,
        context_token: "reply-context",
        item_list: [{
          type: 1,
          text_item: { text: "private inbound body" },
        }],
      }],
    }), { status: 200 })),
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

function exactUpdatesResponse(value: unknown): string {
  return JSON.stringify(value).replace(
    /"message_id":"(\d+)"/gu,
    '"message_id":$1',
  );
}
