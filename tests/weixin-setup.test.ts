import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runWeixinSetup } from "../scripts/weixin-setup.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Weixin setup", () => {
  it("cancels before requesting a QR code", async () => {
    const fixture = createFixture();
    const runLogin = vi.fn();
    let output = "";

    await expect(runWeixinSetup({
      environment: fixture.environment,
      output: { write: (value: string) => {
        output += value;
        return true;
      } },
      prompter: prompter([], [false]),
      runLogin,
    })).resolves.toBeUndefined();

    expect(runLogin).not.toHaveBeenCalled();
    expect(output).toContain("可能用新连接替换");
    expect(output).toContain("未请求微信二维码");
  });

  it("atomically stores a confirmed credential and disabled runtime config", async () => {
    const fixture = createFixture();
    const store = memoryStore();
    const prompt = prompter([], [true, true]);
    let output = "";

    const result = await runWeixinSetup({
      environment: fixture.environment,
      output: { write: (value: string) => {
        output += value;
        return true;
      } },
      prompter: prompt,
      runLogin: async (options: {
        displayQr(value: string): Promise<void>;
        onStatus(status: string): void;
      }) => {
        await options.displayQr("qr-visible");
        options.onStatus("scaned");
        return {
          kind: "confirmed",
          accountId: "bot-fixture@im.bot",
          userId: "actor-fixture@im.wechat",
          botToken: "bot-secret",
          baseUrl: "https://ilinkai.weixin.qq.com",
        };
      },
      renderQRCode: vi.fn(),
      createCredentialStore: async () => store,
      validateCredential: async (login: {
        accountId: string;
        botToken: string;
        baseUrl: string;
      }, grantedAt: number) => ({
        version: 1,
        accountId: login.accountId,
        botToken: login.botToken,
        baseUrl: login.baseUrl,
        grantedAt,
      }),
      now: () => 1_000,
    });

    expect(result).toEqual({
      accountId: "bot-fixture@im.bot",
      allowedUserIds: ["actor-fixture@im.wechat"],
      configPath: fixture.configPath,
    });
    expect(store.set).toHaveBeenCalledWith({
      version: 1,
      accountId: "bot-fixture@im.bot",
      botToken: "bot-secret",
      baseUrl: "https://ilinkai.weixin.qq.com",
      grantedAt: 1_000,
    });
    expect(parseToml(readFileSync(fixture.configPath, "utf8")).weixin)
      .toEqual({
        enabled: false,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      });
    expect(output).not.toContain("bot-secret");
    expect(output).toContain("消息接收尚未启用");
  });

  it("restores the previous credential when config persistence fails", async () => {
    const fixture = createFixture();
    const previous = {
      version: 1 as const,
      accountId: "bot-fixture@im.bot",
      botToken: "old-secret",
      baseUrl: "https://ilinkai.weixin.qq.com",
      grantedAt: 500,
    };
    const store = memoryStore(previous);

    await expect(runWeixinSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: prompter([], [true, true]),
      runLogin: async () => ({
        kind: "confirmed",
        accountId: "bot-fixture@im.bot",
        userId: "actor-fixture@im.wechat",
        botToken: "new-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
      createCredentialStore: async () => store,
      validateCredential: async () => ({
        ...previous,
        botToken: "new-secret",
        grantedAt: 1_000,
      }),
      writeConfig: () => {
        throw new Error("config failed");
      },
    })).rejects.toThrow("config failed");

    expect(store.set).toHaveBeenLastCalledWith(previous);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-weixin-setup-"));
  temporaryDirectories.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "Workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  initializeUserData({ environment, cwd: workspace });
  return {
    environment,
    configPath: join(home, "config.toml"),
  };
}

function prompter(answers: string[], confirmations: boolean[]) {
  return {
    ask: vi.fn(async () => answers.shift() ?? ""),
    secret: vi.fn(async () => answers.shift() ?? ""),
    confirm: vi.fn(async () => confirmations.shift() ?? false),
    close: vi.fn(),
  };
}

function memoryStore(previous: unknown = null) {
  return {
    get: vi.fn(async () => previous),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
