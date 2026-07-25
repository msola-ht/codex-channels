import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runFeishuSetup } from "../scripts/feishu-setup.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";

const temporaryDirectories: string[] = [];

interface RegistrationOptions {
  onQRCodeReady(info: {
    url: string;
    expireIn: number;
  }): void;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-connect-feishu-setup-"));
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

function createPrompter(
  answers: string[],
  confirmations: boolean[],
) {
  return {
    ask: vi.fn(async () => answers.shift() ?? ""),
    secret: vi.fn(async () => answers.shift() ?? ""),
    confirm: vi.fn(async () => confirmations.shift() ?? false),
    close: vi.fn(),
  };
}

describe("Feishu setup", () => {
  it("accepts manually entered credentials and validates the selected bot", async () => {
    const fixture = createFixture();
    const registerApplication = vi.fn();
    const validateApplication = vi.fn(async () => ({
      openId: "ou_bot",
      name: "Manual Bot",
    }));
    const prompter = createPrompter([
      "1",
      "cli_0123456789abcdef",
      "manual-secret",
      "ou_manual",
    ], [true]);
    let renderedOutput = "";

    await runFeishuSetup({
      environment: fixture.environment,
      output: {
        write: (value: string) => {
          renderedOutput += value;
          return true;
        },
      },
      prompter,
      registerApplication,
      validateApplication,
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    });

    expect(registerApplication).not.toHaveBeenCalled();
    expect(validateApplication).toHaveBeenCalledWith({
      appId: "cli_0123456789abcdef",
      appSecret: "manual-secret",
    });
    const configured = parseToml(readFileSync(fixture.configPath, "utf8"));
    expect(configured.feishu).toEqual({
      enabled: true,
      app_id: "cli_0123456789abcdef",
      app_secret: "manual-secret",
      allowed_open_ids: ["ou_manual"],
    });
    expect(renderedOutput).toContain("1. 手动输入应用凭据");
    expect(renderedOutput).toContain("2. 扫码授权");
    expect(renderedOutput).not.toContain("manual-secret");
  });

  it("lets Feishu choose a new or existing app with minimal permissions and saves the scan user", async () => {
    const fixture = createFixture();
    const registerApplication = vi.fn(async (options) => {
      options.onQRCodeReady({
        url: "https://applink.feishu.cn/client/mini_program/open?device=short-lived",
        expireIn: 600,
      });
      return {
        client_id: "cli_0123456789abcdef",
        client_secret: "app-secret",
        user_info: {
          open_id: "ou_scanner",
          tenant_brand: "feishu",
        },
      };
    });
    const renderQRCode = vi.fn();
    const prompter = createPrompter(["2", "ou_extra, ou_scanner"], [true]);
    let renderedOutput = "";

    const result = await runFeishuSetup({
      environment: fixture.environment,
      output: {
        write: (value: string) => {
          renderedOutput += value;
          return true;
        },
      },
      prompter,
      registerApplication,
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Codex Bot",
      }),
      renderQRCode,
      createSignal: () => new AbortController().signal,
    });

    expect(registerApplication).toHaveBeenCalledWith({
      source: "codexc",
      signal: expect.any(globalThis.AbortSignal),
      addons: {
        preset: false,
        scopes: {
          tenant: ["im:message:send_as_bot"],
        },
        events: {
          items: {
            tenant: ["im.message.receive_v1"],
          },
        },
      },
      onQRCodeReady: expect.any(Function),
    });
    expect(renderQRCode).toHaveBeenCalledWith(
      "https://applink.feishu.cn/client/mini_program/open?device=short-lived",
      expect.any(Object),
    );
    const configured = parseToml(readFileSync(fixture.configPath, "utf8"));
    expect(configured.feishu).toEqual({
      enabled: true,
      app_id: "cli_0123456789abcdef",
      app_secret: "app-secret",
      allowed_open_ids: ["ou_scanner", "ou_extra"],
    });
    expect(configured.telegram).toBeDefined();
    expect(result).toEqual({
      appId: "cli_0123456789abcdef",
      allowedOpenIds: ["ou_scanner", "ou_extra"],
      configPath: fixture.configPath,
    });
    expect(renderedOutput).toContain("选择新建应用或已有应用");
    expect(renderedOutput).toContain("cli_0123456789abcdef");
    expect(renderedOutput).not.toContain("app-secret");
    expect(prompter.close).toHaveBeenCalledOnce();
  });

  it("does not constrain the app selection before opening the Feishu page", async () => {
    const fixture = createFixture();
    const registerApplication = vi.fn(async () => ({
      client_id: "cli_fedcba9876543210",
      client_secret: "selected-secret",
      user_info: {
        open_id: "ou_owner",
        tenant_brand: "feishu",
      },
    }));
    const prompter = createPrompter(["2", ""], [true]);

    await runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter,
      registerApplication,
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Existing Bot",
      }),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    });

    expect(registerApplication).toHaveBeenCalledWith(expect.not.objectContaining({
      createOnly: expect.anything(),
      appId: expect.anything(),
    }));
    const configured = parseToml(readFileSync(fixture.configPath, "utf8"));
    expect(configured.feishu).toMatchObject({
      app_id: "cli_fedcba9876543210",
      allowed_open_ids: ["ou_owner"],
    });
  });

  it("preserves an existing allowlist only after explicit confirmation", async () => {
    const fixture = createFixture();
    const initial = readFileSync(fixture.configPath, "utf8");
    const withFeishu = `${initial}\n[feishu]\nenabled = true\napp_id = "cli_0123456789abcdef"\napp_secret = "old-secret"\nallowed_open_ids = ["ou_existing"]\n`;
    writeFileSync(fixture.configPath, withFeishu, { mode: 0o600 });
    const prompter = createPrompter(["2", ""], [true, true]);

    await runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter,
      registerApplication: async () => ({
        client_id: "cli_0123456789abcdef",
        client_secret: "new-secret",
        user_info: {
          open_id: "ou_scanner",
          tenant_brand: "feishu",
        },
      }),
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Existing Bot",
      }),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    });

    const configured = parseToml(readFileSync(fixture.configPath, "utf8"));
    expect((configured.feishu as {
      allowed_open_ids: string[];
    }).allowed_open_ids).toEqual([
      "ou_scanner",
      "ou_existing",
    ]);
  });

  it("preserves an existing allowlist in manual credential mode", async () => {
    const fixture = createFixture();
    const initial = readFileSync(fixture.configPath, "utf8");
    writeFileSync(
      fixture.configPath,
      `${initial}\n[feishu]\nenabled = true\napp_id = "cli_0123456789abcdef"\napp_secret = "old-secret"\nallowed_open_ids = ["ou_existing"]\n`,
      { mode: 0o600 },
    );

    await runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: createPrompter([
        "1",
        "cli_fedcba9876543210",
        "new-secret",
        "",
      ], [true, true]),
      registerApplication: vi.fn(),
      validateApplication: async () => ({
        openId: "ou_bot",
        name: "Manual Bot",
      }),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    });

    const configured = parseToml(readFileSync(fixture.configPath, "utf8"));
    expect((configured.feishu as {
      allowed_open_ids: string[];
    }).allowed_open_ids).toEqual(["ou_existing"]);
  });

  it("rejects Lark tenants and does not persist returned credentials", async () => {
    const fixture = createFixture();
    const before = readFileSync(fixture.configPath, "utf8");
    const prompter = createPrompter(["2"], []);

    await expect(runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter,
      registerApplication: async () => ({
        client_id: "cli_0123456789abcdef",
        client_secret: "must-not-be-saved",
        user_info: {
          open_id: "ou_scanner",
          tenant_brand: "lark",
        },
      }),
      validateApplication: vi.fn(),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    })).rejects.toThrow("暂不支持 Lark");

    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
    expect(prompter.close).toHaveBeenCalledOnce();
  });

  it("does not expose an upstream registration error or change the config", async () => {
    const fixture = createFixture();
    const before = readFileSync(fixture.configPath, "utf8");
    const prompter = createPrompter(["2"], []);

    await expect(runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter,
      registerApplication: async () => {
        throw Object.assign(new Error("response contains secret-body"), {
          code: "server_error",
          description: "secret-body",
        });
      },
      validateApplication: vi.fn(),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    })).rejects.toThrow("飞书扫码注册失败");
    await expect(runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: createPrompter(["2"], []),
      registerApplication: async () => {
        throw new Error("secret-body");
      },
      validateApplication: vi.fn(),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    })).rejects.not.toThrow("secret-body");
    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
  });

  it("rejects HTTPS lookalike domains from the registration response", async () => {
    const fixture = createFixture();
    const before = readFileSync(fixture.configPath, "utf8");

    await expect(runFeishuSetup({
      environment: fixture.environment,
      output: { write: () => true },
      prompter: createPrompter(["2"], []),
      registerApplication: async (options: RegistrationOptions) => {
        options.onQRCodeReady({
          url: "https://accounts.feishu.cn.example.com/authorize?device=secret",
          expireIn: 600,
        });
        throw new Error("unreachable");
      },
      validateApplication: vi.fn(),
      renderQRCode: vi.fn(),
      createSignal: () => new AbortController().signal,
    })).rejects.toThrow("飞书扫码授权地址来源无效");

    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
  });
});
