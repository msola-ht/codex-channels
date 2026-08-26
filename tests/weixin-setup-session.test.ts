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

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import {
  createWeixinSetupSession,
} from "../scripts/weixin-setup-session.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Weixin setup session", () => {
  it("binds lifecycle operations to one owner and never exposes credentials", async () => {
    const fixture = createFixture();
    const store = memoryStore();
    const session = createWeixinSetupSession({
      ownerId: "owner-1",
      timeoutMs: 60_000,
    }, {
      environment: fixture.environment,
      createSessionId: () => "session-1",
      createCredentialStore: async () => store,
      validateCredential: async (login: {
        accountId: string;
        botToken: string;
        baseUrl?: string;
      }) => ({
        version: 1,
        accountId: login.accountId,
        botToken: login.botToken,
        baseUrl: login.baseUrl ?? "https://ilinkai.weixin.qq.com",
        grantedAt: 1_000,
      }),
      runLogin: async (options: {
        displayQr(value: string): Promise<void>;
        readVerifyCode(): Promise<string>;
        onStatus(status: string): void;
      }) => {
        await options.displayQr("qr-visible");
        options.onStatus("need_verifycode");
        expect(await options.readVerifyCode()).toBe("123456");
        return {
          kind: "confirmed",
          accountId: "bot-fixture@im.bot",
          userId: "actor-fixture@im.wechat",
          botToken: "bot-secret",
          baseUrl: "https://ilinkai.weixin.qq.com",
        };
      },
    });

    expect(session.start("owner-1")).toMatchObject({
      sessionId: "session-1",
      state: "waiting-for-scan",
    });
    await vi.waitFor(() => {
      expect(session.status("owner-1").state)
        .toBe("verification-required");
    });
    expect(() => session.status("owner-2")).toThrowError(
      expect.objectContaining({ code: "owner-mismatch" }),
    );
    expect(JSON.stringify(session.status("owner-1")))
      .not.toContain("bot-secret");

    session.provideVerificationCode("owner-1", "123456");
    await expect(session.waitForLogin("owner-1")).resolves.toMatchObject({
      state: "ready",
      preview: {
        accountId: "bot-fixture@im.bot",
        scannerId: "actor-fixture@im.wechat",
        credentialConfigured: true,
        existingAllowedUserCount: 0,
        enabled: false,
      },
    });
    expect(JSON.stringify(session.status("owner-1")))
      .not.toContain("bot-secret");

    await expect(session.confirm("owner-1")).resolves.toMatchObject({
      action: "configured",
      accountId: "bot-fixture@im.bot",
      allowedUserIds: ["actor-fixture@im.wechat"],
      activation: "restart-gateway",
      warnings: [],
    });
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({
      botToken: "bot-secret",
    }));
    expect(parseToml(readFileSync(fixture.configPath, "utf8")).weixin)
      .toEqual({
        enabled: false,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      });
    expect(JSON.stringify(session.status("owner-1")))
      .not.toContain("bot-secret");
  });

  it("cancels an active login and discards the QR value", async () => {
    const fixture = createFixture();
    let observedSignal: AbortSignal | undefined;
    const session = createWeixinSetupSession({ ownerId: "owner-1" }, {
      environment: fixture.environment,
      runLogin: async (options: {
        signal: AbortSignal;
        displayQr(value: string): Promise<void>;
      }) => {
        observedSignal = options.signal;
        await options.displayQr("qr-visible");
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { code: "aborted" }));
          }, { once: true });
        });
      },
    });

    session.start("owner-1");
    await vi.waitFor(() => {
      expect(session.status("owner-1").qrCode).toBe("qr-visible");
    });
    expect(session.cancel("owner-1")).toMatchObject({ state: "cancelled" });
    expect(observedSignal?.aborted).toBe(true);
    expect(session.status("owner-1")).not.toHaveProperty("qrCode");
    expect(session.status("owner-1")).not.toHaveProperty("preview");
    await expect(session.waitForLogin("owner-1")).resolves.toMatchObject({
      state: "cancelled",
    });
  });

  it("does not become ready after cancellation during credential validation", async () => {
    const fixture = createFixture();
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let finishValidation!: (credential: {
      version: 1;
      accountId: string;
      botToken: string;
      baseUrl: string;
      grantedAt: number;
    }) => void;
    const validation = new Promise<{
      version: 1;
      accountId: string;
      botToken: string;
      baseUrl: string;
      grantedAt: number;
    }>((resolve) => {
      finishValidation = resolve;
    });
    const session = createWeixinSetupSession({ ownerId: "owner-1" }, {
      environment: fixture.environment,
      validateCredential: async () => {
        validationStarted();
        return validation;
      },
      runLogin: async () => ({
        kind: "confirmed",
        accountId: "bot-fixture@im.bot",
        userId: "actor-fixture@im.wechat",
        botToken: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    });

    session.start("owner-1");
    await started;
    session.cancel("owner-1");
    finishValidation({
      version: 1,
      accountId: "bot-fixture@im.bot",
      botToken: "bot-secret",
      baseUrl: "https://ilinkai.weixin.qq.com",
      grantedAt: 1_000,
    });

    await expect(session.waitForLogin("owner-1")).resolves.toMatchObject({
      state: "cancelled",
    });
    expect(session.status("owner-1")).not.toHaveProperty("preview");
  });

  it("does not become ready after expiration during credential validation", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let finishValidation!: (credential: {
      version: 1;
      accountId: string;
      botToken: string;
      baseUrl: string;
      grantedAt: number;
    }) => void;
    const validation = new Promise<{
      version: 1;
      accountId: string;
      botToken: string;
      baseUrl: string;
      grantedAt: number;
    }>((resolve) => {
      finishValidation = resolve;
    });
    const session = createWeixinSetupSession({
      ownerId: "owner-1",
      timeoutMs: 1_000,
    }, {
      environment: fixture.environment,
      now: () => Date.now(),
      validateCredential: async () => {
        validationStarted();
        return validation;
      },
      runLogin: async () => ({
        kind: "confirmed",
        accountId: "bot-fixture@im.bot",
        userId: "actor-fixture@im.wechat",
        botToken: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    });

    session.start("owner-1");
    await started;
    await vi.advanceTimersByTimeAsync(1_000);
    finishValidation({
      version: 1,
      accountId: "bot-fixture@im.bot",
      botToken: "bot-secret",
      baseUrl: "https://ilinkai.weixin.qq.com",
      grantedAt: 1_000,
    });

    await expect(session.waitForLogin("owner-1")).resolves.toMatchObject({
      state: "expired",
    });
    expect(session.status("owner-1")).not.toHaveProperty("preview");
  });

  it("expires a ready preview and discards its controlled credential state", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const session = createWeixinSetupSession({
      ownerId: "owner-1",
      timeoutMs: 1_000,
    }, {
      environment: fixture.environment,
      now: () => Date.now(),
      validateCredential: async () => ({
        version: 1,
        accountId: "bot-fixture@im.bot",
        botToken: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
        grantedAt: 1_000,
      }),
      runLogin: async () => ({
        kind: "confirmed",
        accountId: "bot-fixture@im.bot",
        userId: "actor-fixture@im.wechat",
        botToken: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    });

    session.start("owner-1");
    await expect(session.waitForLogin("owner-1")).resolves.toMatchObject({
      state: "ready",
      preview: { credentialConfigured: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(session.status("owner-1")).toMatchObject({ state: "expired" });
    expect(session.status("owner-1")).not.toHaveProperty("preview");
  });

  it("rejects confirmation when the persisted Weixin config changed", async () => {
    const fixture = createFixture();
    const session = createWeixinSetupSession({ ownerId: "owner-1" }, {
      environment: fixture.environment,
      validateCredential: async () => ({
        version: 1,
        accountId: "bot-fixture@im.bot",
        botToken: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
        grantedAt: 1_000,
      }),
      runLogin: async () => ({
        kind: "confirmed",
        accountId: "bot-fixture@im.bot",
        userId: "actor-fixture@im.wechat",
        botToken: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    });
    session.start("owner-1");
    await session.waitForLogin("owner-1");
    const document = readGatewayConfig(fixture.configPath);
    document.weixin = {
      enabled: false,
      account_id: "changed@im.bot",
      allowed_user_ids: [],
    };
    writeGatewayConfig(fixture.configPath, document);

    await expect(session.confirm("owner-1")).rejects.toMatchObject({
      code: "stale-session",
      field: "session",
    });
    expect(session.status("owner-1").state).toBe("ready");
    session.cancel("owner-1");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-weixin-session-"));
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

function memoryStore(previous: unknown = null) {
  return {
    get: vi.fn(async () => previous),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
