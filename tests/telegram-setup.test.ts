import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createPrompter, discardPendingMessageUpdates, isDirectExecution, normalizeUserIds, resolveTelegramProxy, runTelegramSetup, waitForPrivateSender } from "../scripts/telegram-setup.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Telegram setup", () => {
  it("echoes a bot token entered through a TTY", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn> };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
    output.isTTY = true;
    output.columns = 80;
    output.rows = 24;
    let renderedOutput = "";
    output.on("data", (chunk) => { renderedOutput += chunk.toString(); });
    const prompt = createPrompter(input, output);
    const token = "123456:abcdefghijklmnopqrstuvwxyzABCDE";

    const answer = prompt.secret("Telegram Bot Token");
    input.write(`${token}\n`);

    await expect(answer).resolves.toBe(token);
    expect(renderedOutput).toContain("Telegram Bot Token：");
    expect(renderedOutput).toContain(token);
    prompt.close();
  });

  it("validates an existing bot, discovers a private sender and preserves other configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-setup-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" };
    initializeUserData({ environment, cwd: workspace });

    let renderedOutput = "";
    const output = { write: (value: string) => { renderedOutput += value; return true; } };
    const answers = ["2", "123456:abcdefghijklmnopqrstuvwxyzABCDE", "y", "y", "987654"];
    const nextAnswer = () => answers.shift() ?? "";
    let updateCalls = 0;
    const result = await runTelegramSetup({
      environment,
      output,
      prompter: {
        ask: async () => nextAnswer(),
        secret: async () => {
          expect(renderedOutput).toContain("输入内容会显示，粘贴后按回车");
          return nextAnswer();
        },
        confirm: async () => ["y", "yes"].includes(nextAnswer().toLowerCase()),
        close: () => undefined,
      },
      createClient: () => ({
        getMe: async () => ({ id: 123456, username: "codex_connect_test_bot" }),
        getUpdates: async () => {
          expect(renderedOutput).toContain("同时获取更新会产生 Telegram 409 冲突");
          updateCalls += 1;
          return updateCalls === 1
            ? [{ update_id: 10, message: { chat: { type: "private" }, from: { id: 111 } } }]
            : [{ update_id: 11, message: { text: "/start setup-code", chat: { type: "private" }, from: { id: 222, username: "owner" } } }];
        },
      }),
      createPairingCode: () => "setup-code",
      waitSeconds: 1,
    });

    const configured = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
    expect(result).toMatchObject({ botUsername: "codex_connect_test_bot", allowedUserIds: "222,987654" });
    expect(configured.telegram).toMatchObject({
      bot_token: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
      allowed_user_ids: [222, 987654],
    });
    expect(configured.default_workspace).toBe("codex-connect");
    expect(renderedOutput).toContain("?start=setup-code");
  });

  it("does not poll an existing bot without explicit confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-setup-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" };
    initializeUserData({ environment, cwd: workspace });
    const answers = ["2", "123456:abcdefghijklmnopqrstuvwxyzABCDE", "no", "333"];
    const defaults: boolean[] = [];

    const result = await runTelegramSetup({
      environment,
      output: new PassThrough(),
      prompter: {
        ask: async () => answers.shift() ?? "",
        secret: async () => answers.shift() ?? "",
        confirm: async (_label: string, defaultValue: boolean) => {
          defaults.push(defaultValue);
          return ["y", "yes"].includes((answers.shift() ?? "").toLowerCase());
        },
        close: () => undefined,
      },
      createClient: () => ({
        getMe: async () => ({ id: 123456, username: "existing_bot" }),
        getUpdates: async () => { throw new Error("不应轮询未确认的已有 Bot"); },
      }),
    });

    expect(defaults).toEqual([false]);
    expect(result.allowedUserIds).toBe("333");
  });

  it("re-prompts only the additional IDs after automatic discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-setup-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" };
    initializeUserData({ environment, cwd: workspace });
    const answers = ["1", "123456:abcdefghijklmnopqrstuvwxyzABCDE", "yes", "yes", "@invalid", ""];
    let updates = 0;
    let renderedOutput = "";

    const result = await runTelegramSetup({
      environment,
      output: { write: (value: string) => { renderedOutput += value; return true; } },
      prompter: {
        ask: async () => answers.shift() ?? "",
        secret: async () => answers.shift() ?? "",
        confirm: async () => ["y", "yes"].includes((answers.shift() ?? "").toLowerCase()),
        close: () => undefined,
      },
      createClient: () => ({
        getMe: async () => ({ id: 123456, username: "new_bot" }),
        getUpdates: async () => {
          updates += 1;
          return updates === 1
            ? []
            : [{ update_id: 1, message: { text: "/start setup-code", chat: { type: "private" }, from: { id: 444 } } }];
        },
      }),
      createPairingCode: () => "setup-code",
      waitSeconds: 1,
    });

    expect(renderedOutput).toContain("无效的 Telegram 用户 ID：@invalid");
    expect(result.allowedUserIds).toBe("444");
  });

  it("ignores stale and non-private updates while discovering the user", async () => {
    let call = 0;
    const client = {
      getUpdates: async () => {
        call += 1;
        if (call === 1) {
          return [{ update_id: 20, message: { chat: { type: "private" }, from: { id: 1 } } }];
        }
        return [
          { update_id: 21, message: { chat: { type: "group" }, from: { id: 2 } } },
          { update_id: 22, message: { text: "/start wrong-code", chat: { type: "private" }, from: { id: 3 } } },
          { update_id: 23, message: { text: "/start setup-code", chat: { type: "private" }, from: { id: 4, first_name: "Test" } } },
        ];
      },
    };
    const offset = await discardPendingMessageUpdates(client);
    const sender = await waitForPrivateSender(client, 1, offset, "setup-code");

    expect(sender).toEqual({ id: "4", username: undefined, displayName: "Test" });
  });

  it("normalizes, deduplicates and validates user IDs", () => {
    expect(normalizeUserIds([" 123 ", "456", "123"])).toBe("123,456");
    expect(() => normalizeUserIds(["@name"])).toThrow("无效的 Telegram 用户 ID");
    expect(() => normalizeUserIds(["9007199254740992"])).toThrow("无效的 Telegram 用户 ID");
    expect(() => normalizeUserIds([])).toThrow("至少需要一个 Telegram 用户 ID");
  });

  it("reuses the configured allowlist without polling the active bot", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-setup-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" };
    initializeUserData({ environment, cwd: workspace });
    const configPath = join(home, "config.toml");
    const token = "123456:abcdefghijklmnopqrstuvwxyzABCDE";
    const document = readGatewayConfig(configPath);
    document.telegram = {
      ...document.telegram as object,
      bot_token: token,
      allowed_user_ids: [123, 456],
    };
    writeGatewayConfig(configPath, document);
    const answers = ["3", "yes"];

    const result = await runTelegramSetup({
      environment,
      output: new PassThrough(),
      prompter: {
        ask: async () => answers.shift() ?? "",
        secret: async () => answers.shift() ?? "",
        confirm: async () => ["y", "yes"].includes((answers.shift() ?? "").toLowerCase()),
        close: () => undefined,
      },
      createClient: () => ({
        getMe: async () => ({ id: 123456, username: "current_bot" }),
        getUpdates: async () => { throw new Error("不应轮询当前 Bot"); },
      }),
    });

    expect(result.allowedUserIds).toBe("123,456");
  });

  it("uses the same proxy precedence as the Gateway", () => {
    expect(resolveTelegramProxy({
      telegram: { proxy_url: "" },
      network: {
        https_proxy: "https://secure-proxy.example",
        http_proxy: "http://fallback.example",
      },
    })).toBe("https://secure-proxy.example/");
    expect(resolveTelegramProxy({
      telegram: { proxy_url: "http://telegram-proxy.example" },
      network: { https_proxy: "https://secure-proxy.example" },
    })).toBe("http://telegram-proxy.example/");
    expect(() => resolveTelegramProxy({
      telegram: { proxy_url: "socks5://telegram-proxy.example" },
    })).toThrow("只支持 http:// 或 https://");
    expect(() => resolveTelegramProxy({
      network: { https_proxy: "not-a-url" },
    })).toThrow("不是有效 URL");
  });

  it("drains every full page of pending updates before accepting a new sender", async () => {
    const calls: Array<{ offset?: number }> = [];
    const client = {
      getUpdates: async (parameters: { offset?: number }) => {
        calls.push(parameters);
        if (calls.length === 1) {
          return Array.from({ length: 100 }, (_, updateId) => ({
            update_id: updateId,
            message: { chat: { type: "private" }, from: { id: updateId + 1 } },
          }));
        }
        if (calls.length === 2) {
          return [{ update_id: 100, message: { chat: { type: "private" }, from: { id: 999 } } }];
        }
        return [{ update_id: 101, message: { text: "/start setup-code", chat: { type: "private" }, from: { id: 1234 } } }];
      },
    };

    const offset = await discardPendingMessageUpdates(client);
    const sender = await waitForPrivateSender(client, 1, offset, "setup-code");

    expect(offset).toBe(101);
    expect(calls.map((call) => call.offset)).toEqual([0, 100, 101]);
    expect(sender.id).toBe("1234");
  });

  it("bounds pending-update cleanup", async () => {
    let calls = 0;
    await expect(discardPendingMessageUpdates({
      getUpdates: async (parameters: { limit: number }) => {
        calls += 1;
        return Array.from({ length: parameters.limit }, (_, updateId) => ({ update_id: calls * 100 + updateId }));
      },
    }, 2)).rejects.toThrow("历史消息更新超过 200 条");
    expect(calls).toBe(3);
  });

  it("accepts exactly the configured pending-update limit", async () => {
    let calls = 0;
    const offset = await discardPendingMessageUpdates({
      getUpdates: async (parameters: { limit: number }) => {
        calls += 1;
        if (parameters.limit === 1) {
          return [];
        }
        const start = (calls - 1) * 100;
        return Array.from({ length: 100 }, (_, updateId) => ({ update_id: start + updateId }));
      },
    }, 2);

    expect(offset).toBe(200);
    expect(calls).toBe(3);
  });

  it("recognizes a direct script path containing spaces", () => {
    const path = "/tmp/Codex Connect/telegram-setup.mjs";
    expect(isDirectExecution(pathToFileURL(path).href, path)).toBe(true);
  });

  it("redacts the bot token from Telegram validation errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-setup-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" };
    initializeUserData({ environment, cwd: workspace });
    const token = "123456:abcdefghijklmnopqrstuvwxyzABCDE";
    const answers = ["2", token];

    await expect(runTelegramSetup({
      environment,
      output: new PassThrough(),
      prompter: {
        ask: async () => answers.shift() ?? "",
        secret: async () => answers.shift() ?? "",
        confirm: async () => false,
        close: () => undefined,
      },
      createClient: () => ({
        getMe: async () => { throw new Error(`request failed: https://api.telegram.org/bot${token}/getMe`); },
        getUpdates: async () => [],
      }),
    })).rejects.toThrow("[REDACTED]");

    await expect(runTelegramSetup({
      environment,
      output: new PassThrough(),
      prompter: {
        ask: async () => "2",
        secret: async () => token,
        confirm: async () => false,
        close: () => undefined,
      },
      createClient: () => ({
        getMe: async () => { throw new Error(`request failed: ${token}`); },
        getUpdates: async () => [],
      }),
    })).rejects.not.toThrow(token);
  });
});
