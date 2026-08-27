import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript contract probe intentionally has no declaration file.
import * as weixinQrContractProbe from "../scripts/weixin-qr-contract-probe.mjs";

const {
  createWeixinQrContractClient,
  runWeixinQrLoginContract,
  WEIXIN_QR_APP_CLIENT_VERSION,
} = weixinQrContractProbe;

describe("Weixin QR contract probe", () => {
  it("defaults to offline help and requires an explicit live flag", () => {
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/weixin-qr-contract-probe.mjs",
    );
    const help = spawnSync(process.execPath, [probePath], {
      encoding: "utf-8",
    });
    const rejected = spawnSync(process.execPath, [probePath, "qr"], {
      encoding: "utf-8",
    });
    const cancelledLive = spawnSync(
      process.execPath,
      [probePath, "qr", "--live"],
      {
        encoding: "utf-8",
        input: "取消\n",
      },
    );

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("只有显式传入 qr --live");
    expect(help.stdout).toContain("重新连接可能删除");
    expect(help.stderr).toBe("");
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("参数无效");
    expect(cancelledLive.status).toBe(0);
    expect(cancelledLive.stdout).toContain("如需继续，请输入“继续”");
    expect(cancelledLive.stdout).toContain("未请求微信二维码");
    expect(cancelledLive.stderr).toBe("");
  });

  it("creates a QR session with the fixed v2.4.6 wire contract", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      qrcode: "qr-secret",
      qrcode_img_content: "https://weixin.qq.com/x/visible-qr",
      ignored: "upstream-extension",
    }));
    const client = createWeixinQrContractClient({
      fetchImpl,
      requestTimeoutMs: 1_000,
    });

    await expect(client.start({
      baseUrl: "https://ilinkai.weixin.qq.com",
      localTokenList: [],
    })).resolves.toEqual({
      qrcode: "qr-secret",
      qrcodeImageContent: "https://weixin.qq.com/x/visible-qr",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "iLink-App-ClientVersion": String(WEIXIN_QR_APP_CLIENT_VERSION),
          "iLink-App-Id": "bot",
        },
        body: JSON.stringify({ local_token_list: [] }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("polls one QR status and strictly selects supported fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot@im.bot",
      ilink_user_id: "user-1",
      baseurl: "https://example.weixin.qq.com",
      ignored: "upstream-extension",
    }));
    const client = createWeixinQrContractClient({ fetchImpl });

    await expect(client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-secret",
      verifyCode: "123456",
    })).resolves.toEqual({
      status: "confirmed",
      botToken: "bot-secret",
      accountId: "bot@im.bot",
      userId: "user-1",
      baseUrl: "https://example.weixin.qq.com",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status"
      + "?qrcode=qr-secret&verify_code=123456",
      expect.objectContaining({
        method: "GET",
        headers: {
          "iLink-App-ClientVersion": String(WEIXIN_QR_APP_CLIENT_VERSION),
          "iLink-App-Id": "bot",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails closed on unsupported or incomplete QR responses", async () => {
    const responses = [
      { status: "unknown" },
      { status: "confirmed", bot_token: "secret" },
      { status: "scaned_but_redirect", redirect_host: "https://evil.test/path" },
      { status: "scaned_but_redirect", redirect_host: "169.254.169.254" },
    ];
    const client = createWeixinQrContractClient({
      fetchImpl: async () => jsonResponse(responses.shift()),
    });

    await expect(client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-1",
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-2",
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-3",
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-4",
    })).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("bounds upstream bodies and never exposes their contents in errors", async () => {
    const upstreamSecret = "upstream-secret-must-not-leak";
    const responses = [
      new Response(upstreamSecret, { status: 502 }),
      new Response(`not-json:${upstreamSecret}`, { status: 200 }),
      new Response("x".repeat(1_048_577), { status: 200 }),
    ];
    const client = createWeixinQrContractClient({
      fetchImpl: vi.fn(async () => responses.shift() as Response),
    });

    for (const qrcode of ["qr-http", "qr-json", "qr-large"]) {
      const error = await client.poll({
        baseUrl: "https://ilinkai.weixin.qq.com",
        qrcode,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: qrcode === "qr-http" ? "http-error" : "invalid-response",
      });
      expect(String(error)).not.toContain(upstreamSecret);
    }
  });

  it("rejects invalid local timing and refresh inputs", async () => {
    expect(() => createWeixinQrContractClient({
      requestTimeoutMs: 0,
    })).toThrow(expect.objectContaining({ code: "invalid-input" }));

    const client = {
      start: vi.fn(async () => ({
        qrcode: "qr-secret",
        qrcodeImageContent: "https://weixin.qq.com/x/visible-qr",
      })),
      poll: vi.fn(async () => ({ status: "wait" })),
    };
    await expect(runWeixinQrLoginContract({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      displayQr: async () => {},
      readVerifyCode: async () => "",
      maxRefreshes: -1,
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("treats request timeout as wait but preserves external cancellation", async () => {
    const fetchImpl = abortableFetch();
    const client = createWeixinQrContractClient({
      fetchImpl,
      requestTimeoutMs: 1,
    });

    await expect(client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-timeout",
    })).resolves.toEqual({
      status: "wait",
      timedOut: true,
    });

    const controller = new AbortController();
    const cancelled = client.poll({
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcode: "qr-cancel",
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "aborted" });
  });

  it("runs redirect and verification states without persisting secrets", async () => {
    const client = {
      start: vi.fn(async () => ({
        qrcode: "qr-secret",
        qrcodeImageContent: "https://weixin.qq.com/x/visible-qr",
      })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: "scaned" })
        .mockResolvedValueOnce({
          status: "scaned_but_redirect",
          redirectHost: "redirect.weixin.qq.com",
        })
        .mockResolvedValueOnce({ status: "need_verifycode" })
        .mockResolvedValueOnce({
          status: "confirmed",
          botToken: "bot-secret",
          accountId: "bot@im.bot",
          userId: "user-1",
          baseUrl: "https://api.weixin.qq.com",
        }),
    };
    const statuses: string[] = [];
    const displayQr = vi.fn(async () => {});
    const readVerifyCode = vi.fn(async () => "123456");

    await expect(runWeixinQrLoginContract({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      displayQr,
      readVerifyCode,
      onStatus: (status: string) => statuses.push(status),
      pollDelayMs: 0,
    })).resolves.toEqual({
      kind: "confirmed",
      botToken: "bot-secret",
      accountId: "bot@im.bot",
      userId: "user-1",
      baseUrl: "https://api.weixin.qq.com",
    });

    expect(displayQr).toHaveBeenCalledWith(
      "https://weixin.qq.com/x/visible-qr",
    );
    expect(readVerifyCode).toHaveBeenCalledOnce();
    expect(statuses).toEqual([
      "scaned",
      "scaned_but_redirect",
      "need_verifycode",
      "confirmed",
    ]);
    expect(client.poll.mock.calls[2]?.[0]).toMatchObject({
      baseUrl: "https://redirect.weixin.qq.com",
      qrcode: "qr-secret",
    });
    expect(client.poll.mock.calls[3]?.[0]).toMatchObject({
      baseUrl: "https://redirect.weixin.qq.com",
      qrcode: "qr-secret",
      verifyCode: "123456",
    });
  });

  it("bounds automatic QR refreshes", async () => {
    const client = {
      start: vi.fn(async () => ({
        qrcode: `qr-${client.start.mock.calls.length}`,
        qrcodeImageContent: "https://weixin.qq.com/x/visible-qr",
      })),
      poll: vi.fn(async () => ({ status: "expired" })),
    };

    await expect(runWeixinQrLoginContract({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      displayQr: async () => {},
      readVerifyCode: async () => "",
      maxRefreshes: 2,
      pollDelayMs: 0,
    })).rejects.toMatchObject({ code: "refresh-limit" });
    expect(client.start).toHaveBeenCalledTimes(3);
  });

  it("cancels the in-flight poll when the overall login deadline expires", async () => {
    const client = {
      start: vi.fn(async () => ({
        qrcode: "qr-secret",
        qrcodeImageContent: "https://weixin.qq.com/x/visible-qr",
      })),
      poll: vi.fn(({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), {
              code: "aborted",
            }));
          }, { once: true });
        })),
    };

    await expect(runWeixinQrLoginContract({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      displayQr: async () => {},
      readVerifyCode: async () => "",
      overallTimeoutMs: 1,
      pollDelayMs: 0,
    })).rejects.toMatchObject({ code: "login-timeout" });
  });

  it("cancels while waiting for a verification code", async () => {
    const controller = new AbortController();
    const client = {
      start: vi.fn(async () => ({
        qrcode: "qr-secret",
        qrcodeImageContent: "https://weixin.qq.com/x/visible-qr",
      })),
      poll: vi.fn(async () => ({ status: "need_verifycode" })),
    };
    const waitingForCode = new Promise<string>(() => {});
    const login = runWeixinQrLoginContract({
      client,
      baseUrl: "https://ilinkai.weixin.qq.com",
      signal: controller.signal,
      displayQr: async () => {},
      readVerifyCode: async () => waitingForCode,
      pollDelayMs: 0,
    });

    await vi.waitFor(() => {
      expect(client.poll).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(login).rejects.toMatchObject({ code: "aborted" });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
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
