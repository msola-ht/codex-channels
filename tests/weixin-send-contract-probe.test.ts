import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as sendProbe from "../scripts/weixin-send-contract-probe.mjs";
// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as updatesProbe from "../scripts/weixin-updates-contract-probe.mjs";

const {
  createWeixinSendContractClient,
  runWeixinReplyContract,
  runWeixinReplyLengthContract,
  runWeixinReplyEchoContract,
  runWeixinReplySequenceContract,
  summarizeSendResponse,
} = sendProbe;
const { createWeixinUpdatesContractClient } = updatesProbe;

describe("Weixin sendmessage contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-send-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [probePath, "reply"], {
      encoding: "utf8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("reply --live");
    expect(help.stdout).toContain("sequence --live");
    expect(help.stdout).toContain("limit --live");
    expect(help.stdout).toContain("echo --live");
    expect(help.stdout).toContain("不保存消息或回复上下文");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
  });

  it("polls once after a fixed reply to inspect outbound echo structure", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(exactUpdatesResponse({
        ret: 0,
        msgs: [inboundMessage("user@im.wechat", "context-secret", 7n)],
        get_updates_buf: "next-cursor",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(exactUpdatesResponse({
        ret: 0,
        msgs: [{
          message_id: "8",
          from_user_id: "bot@im.bot",
          message_type: 2,
          message_state: 2,
          client_id: "codex-connect:1700000000000-aabbccdd",
          item_list: [{
            type: 1,
            text_item: { text: "private outbound body" },
          }],
        }],
        get_updates_buf: "echo-cursor",
      }), { status: 200 }));
    const updatesClient = createWeixinUpdatesContractClient({ fetchImpl });
    const sendClient = {
      sendText: vi.fn(async () => ({
        kind: "success",
        hasReturnCode: true,
      })),
    };

    await expect(runWeixinReplyEchoContract({
      updatesClient,
      sendClient,
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["user@im.wechat"],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      inbound: { kind: "success", messageCount: 1 },
      outbound: { kind: "success", hasReturnCode: true },
      echo: {
        kind: "success",
        messageCount: 1,
        messages: [{
          messageType: 2,
          clientIdShape: "codex-connect-client",
        }],
      },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      get_updates_buf: "next-cursor",
    });
  });

  it("sends the fixed v2.4.6 completed text reply contract", async () => {
    let randomCall = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        ret: 0,
        errmsg: "upstream secret detail",
      }), { status: 200 }));
    const client = createWeixinSendContractClient({
      fetchImpl,
      timeoutMs: 1_000,
      nowImpl: () => 1_700_000_000_000,
      randomBytesImpl: () => {
        randomCall += 1;
        return randomCall === 1
          ? Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])
          : Buffer.from([0, 0, 0, 1]);
      },
    });

    await expect(client.sendText({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
      toUserId: "private-user@im.wechat",
      contextToken: "context-secret",
      text: "固定测试文本",
    })).resolves.toEqual({
      kind: "success",
      hasReturnCode: true,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
    expect(init).toMatchObject({
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
    expect(JSON.parse(String(init?.body))).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "private-user@im.wechat",
        client_id: "codex-connect:1700000000000-aabbccdd",
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 1,
          text_item: { text: "固定测试文本" },
        }],
        context_token: "context-secret",
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "CodexConnect/0.147.0",
      },
    });
  });

  it("returns only stable API status without upstream text", () => {
    const result = summarizeSendResponse(JSON.stringify({
      ret: -14,
      errmsg: "upstream secret detail",
    }));

    expect(result).toEqual({ kind: "api-error", ret: -14 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails closed on malformed responses", () => {
    expect(() => summarizeSendResponse("not-json")).toThrow(
      expect.objectContaining({ code: "invalid-response" }),
    );
    expect(() => summarizeSendResponse(JSON.stringify({ ret: 1.5 }))).toThrow(
      expect.objectContaining({ code: "invalid-response" }),
    );
  });

  it("distinguishes timeout and external cancellation", async () => {
    const client = createWeixinSendContractClient({
      fetchImpl: abortableFetch(),
      timeoutMs: 1,
    });
    await expect(client.sendText(validSendInput())).rejects.toMatchObject({
      code: "timeout",
    });

    const controller = new AbortController();
    const pending = client.sendText({
      ...validSendInput(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("uses an authorized completed text context only in memory", async () => {
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
    const sendText = vi.fn(async () => ({
      kind: "success",
      hasReturnCode: true,
    }));

    const result = await runWeixinReplyContract({
      updatesClient,
      sendClient: { sendText },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    });

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      toUserId: "allowed-user@im.wechat",
      contextToken: "reply-context",
      text: "微信发送合同验证：短文本回复成功。",
    }));
    expect(result).toMatchObject({
      inbound: { kind: "success", messageCount: 2 },
      outbound: { kind: "success" },
    });
    expect(JSON.stringify(result)).not.toContain("allowed-user");
    expect(JSON.stringify(result)).not.toContain("reply-context");
    expect(JSON.stringify(result)).not.toContain("private-cursor");
    expect(JSON.stringify(result)).not.toContain("bot-secret");
    expect(() => updatesProbe.selectWeixinReplyContext(
      result.inbound,
      ["allowed-user@im.wechat"],
    )).toThrow(expect.objectContaining({ code: "invalid-response" }));
  });

  it("does not send when the batch has no authorized reply context", async () => {
    const updatesClient = createWeixinUpdatesContractClient({
      fetchImpl: vi.fn(async () => new Response(exactUpdatesResponse({
        ret: 0,
        get_updates_buf: "private-cursor",
        msgs: [inboundMessage("other-user@im.wechat", "context", 1n)],
      }), { status: 200 })),
    });
    const sendText = vi.fn();

    await expect(runWeixinReplyContract({
      updatesClient,
      sendClient: { sendText },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    })).rejects.toMatchObject({ code: "invalid-response" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("reuses one authorized context for two fixed Unicode messages", async () => {
    const updatesClient = createUpdatesClient(
      inboundMessage("allowed-user@im.wechat", "reply-context", 1n),
    );
    const sendText = vi.fn()
      .mockResolvedValueOnce({ kind: "success", hasReturnCode: false })
      .mockResolvedValueOnce({ kind: "success", hasReturnCode: false });

    const result = await runWeixinReplySequenceContract({
      updatesClient,
      sendClient: { sendText },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls.map(([input]) => input.contextToken)).toEqual([
      "reply-context",
      "reply-context",
    ]);
    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "微信发送合同验证 1/2：同一上下文连续回复。",
      "微信发送合同验证 2/2：Unicode 中文，emoji 🧪，Markdown **粗体** 与 `code`。",
    ]);
    expect(result).toMatchObject({
      inbound: { kind: "success", messageCount: 1 },
      outbound: [{ kind: "success" }, { kind: "success" }],
    });
    expect(JSON.stringify(result)).not.toContain("reply-context");
    expect(JSON.stringify(result)).not.toContain("allowed-user");
  });

  it("stops a reply sequence after the first API error", async () => {
    const updatesClient = createUpdatesClient(
      inboundMessage("allowed-user@im.wechat", "reply-context", 1n),
    );
    const sendText = vi.fn()
      .mockResolvedValueOnce({ kind: "api-error", ret: -14 });

    const result = await runWeixinReplySequenceContract({
      updatesClient,
      sendClient: { sendText },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(result.outbound).toEqual([{ kind: "api-error", ret: -14 }]);
  });

  it("sends one fixed 4000-character CJK probe without exposing its body", async () => {
    const updatesClient = createUpdatesClient(
      inboundMessage("allowed-user@im.wechat", "reply-context", 1n),
    );
    const sendText = vi.fn()
      .mockResolvedValueOnce({ kind: "success", hasReturnCode: false });

    const result = await runWeixinReplyLengthContract({
      updatesClient,
      sendClient: { sendText },
      credential: {
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-secret",
      },
      allowedUserIds: ["allowed-user@im.wechat"],
    });

    expect(sendText).toHaveBeenCalledOnce();
    const input = sendText.mock.calls[0]![0];
    expect(input.text).toHaveLength(4_000);
    expect(Buffer.byteLength(input.text, "utf8")).toBeGreaterThan(4_000);
    expect(input.text).toMatch(/^微信长度合同验证：4000 字符｜开始｜/u);
    expect(input.text).toMatch(/｜结束$/u);
    expect(result).toMatchObject({
      inbound: { kind: "success", messageCount: 1 },
      outbound: [{ kind: "success" }],
    });
    expect(JSON.stringify(result)).not.toContain("微信长度合同验证");
    expect(JSON.stringify(result)).not.toContain("reply-context");
  });
});

function validSendInput() {
  return {
    baseUrl: "https://ilinkai.weixin.qq.com",
    botToken: "bot-secret",
    toUserId: "actor@im.wechat",
    contextToken: "context-secret",
    text: "test",
  };
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

function createUpdatesClient(message: ReturnType<typeof inboundMessage>) {
  return createWeixinUpdatesContractClient({
    fetchImpl: vi.fn(async () => new Response(exactUpdatesResponse({
      ret: 0,
      get_updates_buf: "private-cursor",
      msgs: [message],
    }), { status: 200 })),
  });
}

function exactUpdatesResponse(value: unknown): string {
  return JSON.stringify(value).replace(
    /"message_id":"(\d+)"/gu,
    '"message_id":$1',
  );
}
