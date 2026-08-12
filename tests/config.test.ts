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
  isDebugLogLevel,
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
  it("derives global debug mode from debug and trace log levels", () => {
    expect(isDebugLogLevel("debug")).toBe(true);
    expect(isDebugLogLevel("trace")).toBe(true);
    expect(isDebugLogLevel("info")).toBe(false);
    expect(isDebugLogLevel("warn")).toBe(false);
  });

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
    expect(runtime.config.planUpdatesEnabled).toBe(true);
    expect(runtime.config.pluginApiEnabled).toBe(false);
    expect(runtime.config.threadSectionAdministrators).toEqual(new Set());
    expect(runtime.config.apiProviders).toEqual([]);
    expect(runtime.config.vision).toEqual({ mode: "disabled" });
    expect(runtime.config.credentialsDirectory).toBe(join(fixture.root, "credentials"));
    expect(runtime.config.codexSocketPath).toBe(join(fixture.root, "runtime/app-server.sock"));
    expect(runtime.config.stateDatabasePath).toBe(join(fixture.root, "data/gateway.sqlite3"));
    expect(runtime.config.workspaces).toEqual([
      { id: "main", name: "Main", cwd: realpathSync(fixture.workspace) },
    ]);
  });

  it("allows an empty Telegram configuration when Feishu is enabled", () => {
    const fixture = createFixture({
      telegram: {
        bot_token: "",
        allowed_user_ids: [],
        message_format: "html",
      },
      feishu: {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        app_secret: "secret",
        allowed_open_ids: ["ou_actor"],
      },
    });

    const runtime = loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config;

    expect(runtime.telegramEnabled).toBe(false);
    expect(runtime.feishu).toBeDefined();
  });

  it("loads canonical Thread Section administrator principals", () => {
    const fixture = createFixture({
      feishu: {
        enabled: true,
        app_id: "cli_0123456789abcdef",
        app_secret: "secret",
        allowed_open_ids: ["ou_admin"],
      },
    });
    const document = readGatewayConfig(fixture.configPath);
    document.thread_sections = {
      administrators: ["telegram:123", "feishu:ou_admin"],
    };
    writeGatewayConfig(fixture.configPath, document);

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.threadSectionAdministrators).toEqual(new Set([
      "telegram:123",
      "feishu:ou_admin",
    ]));
  });

  it("allows an enabled Weixin actor containing a colon to administer Thread Sections", () => {
    const actorId = "actor:tenant@im.wechat";
    const fixture = createFixture({
      weixin: {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: [actorId],
      },
    });
    const document = readGatewayConfig(fixture.configPath);
    document.thread_sections = { administrators: [`weixin:${actorId}`] };
    writeGatewayConfig(fixture.configPath, document);

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.threadSectionAdministrators).toEqual(new Set([`weixin:${actorId}`]));
  });

  it("rejects malformed Thread Section administrator principals", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.thread_sections = { administrators: ["ou_admin"] };
    writeGatewayConfig(fixture.configPath, document);

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("Thread 分区管理员必须使用 <渠道>:<用户 ID>");
  });

  it("rejects Thread Section administrators outside the enabled channel allowlists", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.thread_sections = { administrators: ["telegram:456"] };
    writeGatewayConfig(fixture.configPath, document);

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("Thread 分区管理员必须属于对应已启用渠道的允许名单");
  });

  it("rejects a configuration without any enabled channel", () => {
    const fixture = createFixture({
      telegram: {
        bot_token: "",
        allowed_user_ids: [],
        message_format: "html",
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("至少需要配置一个通讯渠道");
  });

  it("requires allowed users when a Telegram token is configured", () => {
    const fixture = createFixture({
      telegram: {
        bot_token: "secret",
        allowed_user_ids: [],
        message_format: "html",
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("Telegram 启用时必须配置 allowed_user_ids");
  });

  it("loads per-workspace permissions and maps approval_policy to camelCase", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const fixture = createFixture({
      root,
      workspaces: [{
        id: "main",
        name: "Main",
        cwd: workspace,
        sandbox: "danger-full-access",
        approval_policy: "never",
      }],
    });

    const runtime = loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    });

    expect(runtime.config.workspaces).toEqual([{
      id: "main",
      name: "Main",
      cwd: realpathSync(workspace),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    }]);
  });

  it("rejects a workspace that combines sandbox with a permission profile", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const fixture = createFixture({
      root,
      workspaces: [{
        id: "main",
        name: "Main",
        cwd: workspace,
        sandbox: "workspace-write",
        permissions: ":workspace",
      }],
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/permissions 与 sandbox 不能同时设置/u);
  });

  it("rejects the removed App Server vision mode", () => {
    const appServer = createFixture({
      vision: { mode: "openai_app_server", model: "gpt-vision" },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: appServer.configPath,
    })).toThrow(/vision\.mode/u);
  });

  it("loads external vision settings without reading API key contents into config", () => {
    const external = createFixture({
      api_providers: [{
        id: "vision-relay",
        name: "视觉中转",
        protocol: "responses",
        endpoint: "https://vision.example/v1/responses",
      }],
      vision: {
        mode: "responses_api",
        provider: "vision-relay",
        model: "vision-model",
      },
    });
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: external.configPath,
    }).config.vision).toEqual({
      mode: "responses_api",
      provider: "vision-relay",
      endpoint: "https://vision.example/v1/responses",
      model: "vision-model",
      timeoutMs: 120_000,
    });
  });

  it("accepts a custom vision timeout and rejects values outside the supported range", () => {
    const custom = createFixture({
      api_providers: [{
        id: "vision-relay",
        name: "视觉中转",
        protocol: "responses",
        endpoint: "https://vision.example/v1/responses",
      }],
      vision: {
        mode: "responses_api",
        provider: "vision-relay",
        model: "vision-model",
        timeout_seconds: 300,
      },
    });
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: custom.configPath,
    }).config.vision).toEqual(expect.objectContaining({
      timeoutMs: 300_000,
    }));

    const invalid = createFixture({
      api_providers: [{
        id: "vision-relay",
        name: "视觉中转",
        protocol: "responses",
        endpoint: "https://vision.example/v1/responses",
      }],
      vision: {
        mode: "responses_api",
        provider: "vision-relay",
        model: "vision-model",
        timeout_seconds: 20,
      },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: invalid.configPath,
    })).toThrow();
  });

  it("rejects insecure remote vision endpoints", () => {
    const fixture = createFixture({
      api_providers: [{
        id: "vision-relay",
        name: "视觉中转",
        protocol: "responses",
        endpoint: "http://vision.example/v1/responses",
      }],
      vision: {
        mode: "responses_api",
        provider: "vision-relay",
        model: "vision-model",
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("必须使用 HTTPS");
  });

  it("rejects a vision provider that is not registered", () => {
    const fixture = createFixture({
      vision: {
        mode: "responses_api",
        provider: "missing",
        model: "vision-model",
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow("vision.provider 不存在");
  });

  it("rejects the removed manual DeepSeek proxy setting", () => {
    const fixture = createFixture({
      ds_proxy: { listen: "127.0.0.1:38473" },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/ds_proxy/u);
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
    delete document.experimental;
    delete document.storage;
    delete document.logging;
    delete document.metrics;
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
      plan_updates: true,
      price_currency: "cny",
    });
    expect(persisted.experimental).toEqual({ plugin_api: false });
    expect(persisted.storage).toEqual({
      database_path: "data/gateway.sqlite3",
    });
    expect(persisted.logging).toEqual({ level: "info" });
    expect(persisted.metrics).toEqual({
      storage: {
        retention_days: 365,
        max_rows: 1_000_000,
      },
      sync: {
        enabled: false,
        batch_size: 200,
        interval_seconds: 60,
      },
    });
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

  it("preserves an explicit automatic plan display opt-out", () => {
    const fixture = createFixture({
      display: {
        operation_updates: "compact",
        plan_updates: false,
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.planUpdatesEnabled).toBe(false);
  });

  it("preserves the explicit global price currency", () => {
    const fixture = createFixture({
      display: {
        operation_updates: "compact",
        plan_updates: true,
        price_currency: "cny",
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.priceCurrency).toBe("cny");
  });

  it("rejects the removed automatic price currency and per-provider overrides", () => {
    const automatic = createFixture({
      display: { price_currency: "auto" },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: automatic.configPath,
    })).toThrow(/price_currency/u);

    const perProvider = createFixture({
      display: {
        price_currency: "cny",
        price_currency_by_provider: { openai: "usd" },
      },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: perProvider.configPath,
    })).toThrow(/price_currency_by_provider/u);
  });

  it("rejects the removed boolean operation update setting", () => {
    const fixture = createFixture({
      display: { show_operation_updates: false },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/show_operation_updates/u);
  });

  it("loads optional webui host, port and token", () => {
    const fixture = createFixture({
      webui: {
        host: "0.0.0.0",
        port: 9000,
        token: "webui-token",
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.webui).toEqual({
      host: "0.0.0.0",
      port: 9000,
      token: "webui-token",
    });
  });

  it("keeps webui out of runtime config when the section is absent", () => {
    const fixture = createFixture();

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.webui).toBeUndefined();
  });

  it("rejects invalid webui host, port or unknown keys", () => {
    const invalidHost = createFixture({
      webui: { host: "0.0.0.1" },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: invalidHost.configPath,
    })).toThrow(/webui/u);

    const invalidPort = createFixture({
      webui: { port: 0 },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: invalidPort.configPath,
    })).toThrow(/webui/u);

    const unknownKey = createFixture({
      webui: { bind: "127.0.0.1" },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: unknownKey.configPath,
    })).toThrow(/webui/u);
  });

  it("rejects non-loopback webui without a token", () => {
    const fixture = createFixture({
      webui: { host: "0.0.0.0" },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/绑定非回环地址时必须设置 token/u);
  });

  it("loads metrics sync defaults when the section is absent", () => {
    const fixture = createFixture();

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.metricsSync).toEqual({
      enabled: false,
      batchSize: 200,
      intervalSeconds: 60,
    });
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.metricsStorage).toEqual({
      retentionDays: 365,
      maxRows: 1_000_000,
    });
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.metricsCenter).toBeUndefined();
  });

  it("loads a configurable metrics retention policy", () => {
    const fixture = createFixture({
      metrics: {
        storage: { retention_days: 90, max_rows: 250_000 },
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.metricsStorage).toEqual({
      retentionDays: 90,
      maxRows: 250_000,
    });
  });

  it("loads an enabled metrics sync section", () => {
    const fixture = createFixture({
      metrics: {
        sync: {
          enabled: true,
          endpoint: "https://worker.example.com/api/ingest",
          device_token: "device-token",
          device_id: "node-a",
          batch_size: 100,
          interval_seconds: 120,
        },
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.metricsSync).toEqual({
      enabled: true,
      endpoint: "https://worker.example.com/api/ingest",
      deviceToken: "device-token",
      deviceId: "node-a",
      batchSize: 100,
      intervalSeconds: 120,
    });
  });

  it("rejects enabled metrics sync without endpoint or token", () => {
    const noEndpoint = createFixture({
      metrics: { sync: { enabled: true, device_token: "token" } },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: noEndpoint.configPath,
    })).toThrow(/metrics\.sync/u);

    const noToken = createFixture({
      metrics: { sync: { enabled: true, endpoint: "https://worker.example.com/api/ingest" } },
    });
    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: noToken.configPath,
    })).toThrow(/metrics\.sync/u);
  });

  it("rejects non-https metrics sync endpoint", () => {
    const fixture = createFixture({
      metrics: {
        sync: {
          enabled: true,
          endpoint: "http://worker.example.com/api/ingest",
          device_token: "token",
        },
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/HTTPS/u);
  });

  it("allows loopback and private http metrics sync endpoints", () => {
    for (const endpoint of [
      "http://127.0.0.1:8790/api/ingest",
      "http://192.168.1.10:8790/api/ingest",
      "http://[::1]:8790/api/ingest",
    ]) {
      const fixture = createFixture({
        metrics: {
          sync: {
            enabled: true,
            endpoint,
            device_token: "token",
          },
        },
      });
      expect(loadRuntimeConfig({
        CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
      }).config.metricsSync).toMatchObject({ endpoint });
    }
  });

  it("loads an enabled metrics center section", () => {
    const fixture = createFixture({
      metrics: {
        center: {
          enabled: true,
          host: "127.0.0.1",
          port: 8790,
          token: "center-token",
          device_token: "device-token",
          database_path: "data/central-metrics.sqlite3",
        },
      },
    });

    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    }).config.metricsCenter).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 8790,
      token: "center-token",
      deviceToken: "device-token",
      databasePath: "data/central-metrics.sqlite3",
    });
  });

  it("rejects non-loopback metrics center without a token", () => {
    const fixture = createFixture({
      metrics: {
        center: {
          enabled: true,
          host: "0.0.0.0",
          port: 8790,
          token: "center-token",
        },
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/metrics\.center/u);
  });

  it("rejects identical metrics center ingest and view tokens", () => {
    const fixture = createFixture({
      metrics: {
        center: {
          enabled: true,
          host: "127.0.0.1",
          port: 8790,
          token: "shared-token",
          device_token: "shared-token",
        },
      },
    });

    expect(() => loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fixture.configPath,
    })).toThrow(/必须不同/u);
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
