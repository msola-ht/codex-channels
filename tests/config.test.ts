import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseGatewayConfig,
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  ConfigurationError,
  loadConfigDocument,
  loadRuntimeConfig,
} from "../src/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Gateway config.toml", () => {
  it("preserves comments when updating an existing configuration", () => {
    const fixture = createFixture();
    const commented = readFixture(fixture.configPath)
      .replace("version = 1", "# Gateway settings\nversion = 1")
      .replace(
        'bot_token = "secret"',
        '# Keep this token private\nbot_token = "secret" # managed by setup',
      );
    writeFileSync(fixture.configPath, commented);

    const document = readGatewayConfig(fixture.configPath);
    const telegram = document.telegram;
    if (!telegram || typeof telegram !== "object" || Array.isArray(telegram)) {
      throw new Error("测试配置缺少 telegram 表");
    }
    Object.assign(telegram, { bot_token: "updated" });
    writeGatewayConfig(fixture.configPath, document);

    const updated = readFixture(fixture.configPath);
    expect(updated).toContain("# Gateway settings");
    expect(updated).toContain("# Keep this token private");
    expect(updated).toContain('bot_token = "updated" # managed by setup');
  });

  it("keeps Workspace comments with their Workspace when earlier entries are removed", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    const main = join(root, "main");
    const secondary = join(root, "secondary");
    mkdirSync(main, { recursive: true });
    mkdirSync(secondary);
    const fixture = createFixture({
      root,
      workspaces: [
        { id: "main", name: "Main", cwd: main },
        { id: "secondary", name: "Secondary", cwd: secondary },
      ],
    });
    const commented = readFixture(fixture.configPath)
      .replace('id = "main"', '# Main workspace\nid = "main"')
      .replace('id = "secondary"', '# Secondary workspace\nid = "secondary"');
    writeFileSync(fixture.configPath, commented);

    const document = readGatewayConfig(fixture.configPath);
    const workspaces = document.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length < 2) {
      throw new Error("测试配置缺少第二个 Workspace");
    }
    document.workspaces = [workspaces[1]!];
    writeGatewayConfig(fixture.configPath, document);

    expect(readFixture(fixture.configPath)).toContain(
      '# Secondary workspace\nid = "secondary"',
    );
  });

  it("does not expose configuration contents in TOML syntax errors", () => {
    const secret = "123456:secret-token-value";
    const malformed = `[telegram]\nbot_token = "${secret}\n`;

    expect(() => parseGatewayConfig(malformed)).toThrow("config.toml 语法无效");
    expect(capturedError(() => parseGatewayConfig(malformed))).not.toContain(secret);
    expect(capturedError(() => loadConfigDocument(malformed, process.cwd()))).not.toContain(secret);
  });

  it("loads config.toml and resolves relative paths from the config directory", () => {
    const fixture = createFixture({
      telegram: {
        bot_token: "secret",
        allowed_user_ids: [123, 456],
        message_format: "rich",
      },
    });

    const runtime = loadRuntimeConfig({ CODEX_CONNECT_CONFIG_FILE: fixture.configPath });

    expect(runtime.configPath).toBe(fixture.configPath);
    expect(runtime.config.telegramBotToken).toBe("secret");
    expect(runtime.config.telegramAllowedUserIds).toEqual(new Set([123, 456]));
    expect(runtime.config.telegramMessageFormat).toBe("rich");
    expect(runtime.config.operationUpdateDisplay).toBe("compact");
    expect(runtime.config.planUpdatesEnabled).toBe(false);
    expect(runtime.config.credentialsDirectory).toBe(join(fixture.root, "credentials"));
    expect(runtime.config.codexSocketPath).toBe(join(fixture.root, "runtime/app-server.sock"));
    expect(runtime.config.stateDatabasePath).toBe(join(fixture.root, "data/gateway.sqlite3"));
    expect(runtime.config.workspaces).toEqual([
      { id: "main", name: "Main", cwd: realpathSync(fixture.workspace) },
    ]);
  });

  it("rejects a config file readable by group or other users", () => {
    const fixture = createFixture();
    chmodSync(fixture.configPath, 0o640);

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("config.toml 权限不安全");
  });

  it("rejects a config file reached through a symbolic link", () => {
    const fixture = createFixture();
    const linkedPath = join(fixture.root, "linked-config.toml");
    symlinkSync(fixture.configPath, linkedPath);

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: linkedPath,
    })).toThrow("config.toml 必须是普通文件且不能是符号链接");
  });

  it("rejects a config file in a group-writable directory", () => {
    const fixture = createFixture();
    chmodSync(fixture.root, 0o770);

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("config.toml 父目录权限不安全");
  });

  it("materializes missing safe defaults after a successful load", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    delete document.approval;
    delete document.display;
    delete document.storage;
    delete document.logging;
    const telegram = document.telegram;
    const codex = document.codex;
    if (
      telegram === null
      || typeof telegram !== "object"
      || Array.isArray(telegram)
      || telegram instanceof Date
      || codex === null
      || typeof codex !== "object"
      || Array.isArray(codex)
      || codex instanceof Date
    ) {
      throw new Error("测试配置缺少 Telegram 或 Codex 表");
    }
    delete telegram.message_format;
    delete codex.binary;
    delete codex.socket_path;
    delete codex.sandbox;
    writeGatewayConfig(fixture.configPath, document);
    writeFileSync(
      fixture.configPath,
      readFixture(fixture.configPath).replace(
        "version = 1",
        "# 自动补齐前的注释\nversion = 1",
      ),
    );

    loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    });

    const persisted = readGatewayConfig(fixture.configPath);
    expect(persisted.telegram).toMatchObject({ message_format: "html" });
    expect(persisted.codex).toMatchObject({
      binary: "codex",
      socket_path: "runtime/codex-app-server.sock",
      sandbox: "workspace-write",
    });
    expect(persisted.approval).toEqual({ timeout_seconds: 300 });
    expect(persisted.display).toEqual({
      operation_updates: "compact",
      plan_updates: false,
    });
    expect(persisted.storage).toEqual({
      database_path: "data/gateway.sqlite3",
    });
    expect(persisted.logging).toEqual({ level: "info" });
    expect(persisted.feishu).toBeUndefined();
    expect(persisted.weixin).toBeUndefined();
    expect(readFixture(fixture.configPath)).toContain(
      "# 自动补齐前的注释",
    );
    expect(statSync(fixture.configPath).mode & 0o777).toBe(0o600);
  });

  it("does not materialize defaults when semantic validation fails", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    delete document.display;
    const workspaces = document.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      throw new Error("测试配置缺少 Workspace");
    }
    const workspace = workspaces[0];
    if (
      workspace === null
      || typeof workspace !== "object"
      || Array.isArray(workspace)
      || workspace instanceof Date
    ) {
      throw new Error("测试 Workspace 格式无效");
    }
    workspace.cwd = join(fixture.root, "missing-workspace");
    writeGatewayConfig(fixture.configPath, document);
    const before = readFixture(fixture.configPath);

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("cwd 必须是已存在的目录");
    expect(readFixture(fixture.configPath)).toBe(before);
  });

  it("uses CODEX_CONNECT_HOME when no explicit config file is set", () => {
    const fixture = createFixture();

    const runtime = loadRuntimeConfig({
      CODEX_CONNECT_HOME: fixture.root,
      TELEGRAM_BOT_TOKEN: "ignored-old-value",
      CODEX_CONNECT_ENV_FILE: join(fixture.root, ".env"),
    });

    expect(runtime.configPath).toBe(fixture.configPath);
    expect(runtime.config.telegramBotToken).toBe("secret");
  });

  it("accepts explicit model, sandbox, timeout and log settings", () => {
    const fixture = createFixture({
      codex: {
        binary: "codex",
        socket_path: "runtime/app-server.sock",
        default_model: "gpt-test",
        sandbox: "read-only",
      },
      approval: { timeout_seconds: 45 },
      logging: { level: "debug" },
    });

    const config = loadRuntimeConfig({ CODEX_CONNECT_CONFIG_FILE: fixture.configPath }).config;

    expect(config.codexModel).toBe("gpt-test");
    expect(config.codexSandbox).toBe("read-only");
    expect(config.approvalTimeoutMs).toBe(45_000);
    expect(config.logLevel).toBe("debug");
  });

  it.each(["full", "compact", "hidden"] as const)(
    "accepts the %s operation update display mode",
    (operationUpdates) => {
      const fixture = createFixture({
        display: { operation_updates: operationUpdates },
      });

      expect(loadRuntimeConfig({
        CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
      }).config.operationUpdateDisplay).toBe(operationUpdates);
    },
  );

  it("accepts explicit automatic plan display", () => {
    const fixture = createFixture({
      display: {
        operation_updates: "compact",
        plan_updates: true,
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.planUpdatesEnabled).toBe(true);
  });

  it("rejects the removed boolean operation update setting", () => {
    const fixture = createFixture({
      display: { show_operation_updates: false },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/show_operation_updates/u);
  });

  it("loads an explicitly enabled Feishu account", () => {
    const fixture = createFixture({
      feishu: {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        app_secret: "secret",
        allowed_open_ids: ["ou_actor", "ou_reviewer"],
      },
    });

    const config = loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config;

    expect(config.feishu).toEqual({
      appId: "cli_0123456789abcdef",
      appSecret: "secret",
      allowedOpenIds: new Set(["ou_actor", "ou_reviewer"]),
    });
  });

  it("keeps Feishu disabled when its table is absent or explicitly disabled", () => {
    const absent = createFixture();
    const disabled = createFixture({
      feishu: {
        enabled: false,
        app_id: "cli_0123456789abcdef",
        app_secret: "stored-secret",
        allowed_open_ids: ["ou_actor"],
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: absent.configPath,
    }).config.feishu).toBeUndefined();
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: disabled.configPath,
    }).config.feishu).toBeUndefined();
  });

  it("keeps disabled Weixin setup metadata out of runtime config", () => {
    const fixture = createFixture({
      weixin: {
        enabled: false,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.weixin).toBeUndefined();
  });

  it("loads an explicitly enabled Weixin account without a plaintext token", () => {
    const enabled = createFixture({
      weixin: {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      },
    });
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: enabled.configPath,
    }).config.weixin).toEqual({
      accountId: "bot-fixture@im.bot",
      allowedUserIds: new Set(["actor-fixture@im.wechat"]),
    });
  });

  it.each([
    [
      "invalid account ID",
      {
        enabled: true,
        account_id: "invalid",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      },
    ],
    [
      "invalid user ID",
      {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["invalid"],
      },
    ],
    [
      "duplicate user IDs",
      {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: [
          "actor-fixture@im.wechat",
          "actor-fixture@im.wechat",
        ],
      },
    ],
  ])("rejects Weixin %s", (_name, weixin) => {
    const fixture = createFixture({ weixin });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(ConfigurationError);
  });

  it.each([
    [
      "missing credentials",
      {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        allowed_open_ids: ["ou_actor"],
      },
    ],
    [
      "invalid App ID",
      {
        enabled: true,
        app_id: "invalid",
        app_secret: "secret",
        allowed_open_ids: ["ou_actor"],
      },
    ],
    [
      "blank App Secret",
      {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        app_secret: "   ",
        allowed_open_ids: ["ou_actor"],
      },
    ],
    [
      "duplicate Open IDs",
      {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        app_secret: "secret",
        allowed_open_ids: ["ou_actor", "ou_actor"],
      },
    ],
    [
      "unsupported group settings",
      {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        app_secret: "secret",
        allowed_open_ids: ["ou_actor"],
        allowed_chat_ids: ["oc_group"],
      },
    ],
  ])("rejects Feishu %s", (_name, feishu) => {
    const fixture = createFixture({ feishu });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(ConfigurationError);
  });

  it("keeps the Telegram proxy explicit and resolves shared proxies separately", () => {
    const explicit = createFixture({
      telegram: {
        bot_token: "secret",
        allowed_user_ids: [123],
        proxy_url: "http://127.0.0.1:7897",
        message_format: "html",
      },
      network: { https_proxy: "http://127.0.0.1:7890" },
    });
    const fallback = createFixture({
      network: { https_proxy: "http://127.0.0.1:7890" },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: explicit.configPath,
    }).config.telegramProxyUrl).toBe("http://127.0.0.1:7897/");
    const fallbackConfig = loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fallback.configPath,
    }).config;
    expect(fallbackConfig.telegramProxyUrl).toBeUndefined();
    expect(fallbackConfig.networkProxy.https).toBe("http://127.0.0.1:7890");
  });

  it("uses inherited proxy variables when network config is empty", () => {
    const fixture = createFixture();
    const config = loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
      HTTPS_PROXY: "http://127.0.0.1:8899",
      NO_PROXY: "localhost",
    }).config;

    expect(config.telegramProxyUrl).toBeUndefined();
    expect(config.networkProxy).toMatchObject({
      https: "http://127.0.0.1:8899",
      no: "localhost",
    });
  });

  it("rejects unsupported proxy protocols", () => {
    const fixture = createFixture({
      telegram: {
        bot_token: "secret",
        allowed_user_ids: [123],
        proxy_url: "socks5://127.0.0.1:7890",
        message_format: "html",
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("HTTP(S) 客户端代理只支持 http:// 或 https://");
  });

  it("rejects unknown keys instead of silently accepting old configuration", () => {
    const fixture = createFixture();
    const content = `${readFixture(fixture.configPath)}\nlegacy_setting = true\n`;

    expect(() => loadConfigDocument(content, fixture.root)).toThrow(ConfigurationError);
  });

  it("rejects a missing workspace and an unknown default workspace", () => {
    const missing = createFixture({
      workspaces: [{ id: "main", name: "Main", cwd: "/definitely/missing/codex-workdir" }],
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: missing.configPath,
    })).toThrow("cwd 必须是已存在的目录");

    const unknownDefault = createFixture({ default_workspace: "missing" });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: unknownDefault.configPath,
    })).toThrow("default_workspace 不存在");
  });

  it("rejects an existing file as a workspace cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(root);
    const file = join(root, "not-a-directory");
    writeFileSync(file, "test");
    const fixture = createFixture({
      root,
      workspaces: [{ id: "main", name: "Main", cwd: file }],
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("cwd 必须是目录");
  });
});

function createFixture(overrides: Record<string, unknown> = {}) {
  const root = typeof overrides.root === "string"
    ? overrides.root
    : mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
  const documentOverrides = { ...overrides };
  delete documentOverrides.root;
  if (!temporaryDirectories.includes(root)) {
    temporaryDirectories.push(root);
  }
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const configPath = join(root, "config.toml");
  const document = {
    version: 1,
    default_workspace: "main",
    telegram: {
      bot_token: "secret",
      allowed_user_ids: [123],
      message_format: "html",
    },
    network: {},
    codex: {
      binary: "codex",
      socket_path: "runtime/app-server.sock",
      sandbox: "workspace-write",
    },
    approval: { timeout_seconds: 300 },
    storage: { database_path: "data/gateway.sqlite3" },
    logging: { level: "info" },
    workspaces: [{ id: "main", name: "Main", cwd: workspace }],
    ...documentOverrides,
  };
  writeGatewayConfig(configPath, document);
  return { root, workspace, configPath };
}

function readFixture(path: string): string {
  return readFileSync(path, "utf8");
}

function capturedError(action: () => unknown): string {
  try {
    action();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
