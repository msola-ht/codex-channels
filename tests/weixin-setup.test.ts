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
      activation: "restart-gateway",
      activationResult: {
        status: "restart",
        target: "gateway",
        commands: ["codexc service restart gateway"],
      },
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
    expect(output).toContain("weixin.enabled");
    expect(output).toContain("codexc service reload");
    expect(output).not.toContain("下一步实现");
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

  it("prompts again when Weixin requests a second verification code", async () => {
    const fixture = createFixture();
    const store = memoryStore();
    const prompt = prompter(["111111", "222222"], [true, true]);

    await expect(runWeixinSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: prompt,
      runLogin: async (options: {
        onStatus(status: string): void;
        readVerifyCode(): Promise<string>;
      }) => {
        options.onStatus("need_verifycode");
        expect(await options.readVerifyCode()).toBe("111111");
        options.onStatus("need_verifycode");
        expect(await options.readVerifyCode()).toBe("222222");
        return {
          kind: "confirmed",
          accountId: "bot-fixture@im.bot",
          userId: "actor-fixture@im.wechat",
          botToken: "bot-secret",
          baseUrl: "https://ilinkai.weixin.qq.com",
        };
      },
      createCredentialStore: async () => store,
      validateCredential: async (login: {
        accountId: string;
        botToken: string;
        baseUrl: string;
      }) => ({
        version: 1,
        accountId: login.accountId,
        botToken: login.botToken,
        baseUrl: login.baseUrl,
        grantedAt: 1_000,
      }),
    })).resolves.toMatchObject({ accountId: "bot-fixture@im.bot" });

    expect(prompt.ask).toHaveBeenCalledTimes(2);
  });

  it("renders a Chinese timeout error from the structured session state", async () => {
    const fixture = createFixture();

    await expect(runWeixinSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: prompter([], [true]),
      runLogin: async () => {
        throw Object.assign(new Error("internal timeout"), {
          code: "login-timeout",
        });
      },
    })).rejects.toThrow("微信二维码登录合同验证超时");
  });

  it("aborts a pending verification prompt when the session expires", async () => {
    const fixture = createFixture();
    let listener: ((status: Record<string, unknown>) => void) | undefined;
    let status: Record<string, unknown> = {
      sessionId: "session-1",
      state: "created",
      revision: 0,
    };
    const prompt = {
      ask: vi.fn((_label: string, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), {
              name: "AbortError",
            }));
          }, { once: true });
        })),
      secret: vi.fn(async () => ""),
      confirm: vi.fn(async () => true),
      close: vi.fn(),
    };
    const run = runWeixinSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: prompt,
      createSetupSession: () => ({
        subscribe: (_ownerId: string, next: typeof listener) => {
          listener = next;
          listener?.(status);
          return () => {};
        },
        start: () => {
          status = {
            sessionId: "session-1",
            state: "verification-required",
            revision: 1,
            verificationRequestId: 1,
          };
          listener?.(status);
          return status;
        },
        waitForLogin: async () => {
          await Promise.resolve();
          status = {
            sessionId: "session-1",
            state: "expired",
            revision: 2,
          };
          listener?.(status);
          return status;
        },
        status: () => status,
        cancel: () => status,
      }),
    }).then(
      () => ({ kind: "resolved" }),
      (error: Error) => ({ kind: "error", message: error.message }),
    );

    const result = await Promise.race([
      run,
      new Promise<{ kind: "pending" }>((resolve) => {
        setTimeout(() => resolve({ kind: "pending" }), 25);
      }),
    ]);

    expect(result).toEqual({
      kind: "error",
      message: "微信二维码登录合同验证超时",
    });
    expect(prompt.close).toHaveBeenCalledOnce();
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
