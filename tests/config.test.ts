import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    expect(runtime.config.codexSocketPath).toBe(join(fixture.root, "runtime/app-server.sock"));
    expect(runtime.config.stateDatabasePath).toBe(join(fixture.root, "data/gateway.sqlite3"));
    expect(runtime.config.workspaces).toEqual([
      { id: "main", name: "Main", cwd: realpathSync(fixture.workspace) },
    ]);
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

  it("prefers the Telegram proxy and otherwise uses the network proxy", () => {
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
    expect(loadRuntimeConfig({
      CODEX_CONNECT_CONFIG_FILE: fallback.configPath,
    }).config.telegramProxyUrl).toBe("http://127.0.0.1:7890/");
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
    })).toThrow("Telegram 代理目前只支持 http:// 或 https://");
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
