import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { validateFeishuApplication } from "../scripts/feishu-application.mjs";

describe("Feishu application validation", () => {
  it("validates the bot identity with a finite SDK request", async () => {
    const request = vi.fn(async () => ({
      bot: {
        open_id: "ou_bot",
        app_name: "Codex Bot",
      },
    }));
    const createClient = vi.fn(() => ({ request }));

    await expect(validateFeishuApplication({
      appId: "cli_0123456789abcdef",
      appSecret: "app-secret",
    }, {
      createClient,
      requestTimeoutMs: 10_000,
    })).resolves.toEqual({
      openId: "ou_bot",
      name: "Codex Bot",
    });

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      appId: "cli_0123456789abcdef",
      appSecret: "app-secret",
      logger: expect.objectContaining({
        error: expect.any(Function),
        warn: expect.any(Function),
        info: expect.any(Function),
        debug: expect.any(Function),
        trace: expect.any(Function),
      }),
      source: "codexc",
    }));
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      timeout: 10_000,
    });
  });

  it("rejects invalid credentials before creating a client", async () => {
    const createClient = vi.fn();

    await expect(validateFeishuApplication({
      appId: "invalid",
      appSecret: "app-secret",
    }, {
      createClient,
    })).rejects.toThrow("飞书应用凭据格式无效");

    expect(createClient).not.toHaveBeenCalled();
  });

  it("hides upstream errors and malformed responses", async () => {
    const secret = "upstream-secret-response";

    await expect(validateFeishuApplication({
      appId: "cli_0123456789abcdef",
      appSecret: "app-secret",
    }, {
      createClient: () => ({
        request: async () => {
          throw new Error(secret);
        },
      }),
    })).rejects.toThrow("飞书应用凭据或机器人身份验证失败");

    await expect(validateFeishuApplication({
      appId: "cli_0123456789abcdef",
      appSecret: "app-secret",
    }, {
      createClient: () => ({
        request: async () => ({ raw: secret }),
      }),
    })).rejects.toThrow("飞书应用凭据或机器人身份验证失败");
  });
});
