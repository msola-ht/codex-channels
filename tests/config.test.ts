import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig, loadRuntimeConfig } from "../src/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("loads a valid log level and derives an absolute socket path", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123,456",
      ...workspaceEnvironment(workdir),
      LOG_LEVEL: "info",
    });

    expect(config.logLevel).toBe("info");
    expect(config.workspaces).toEqual([
      { id: "main", name: "Main", cwd: realpathSync(workdir) },
    ]);
    expect(config.defaultWorkspaceId).toBe("main");
    expect(config.codexSocketPath).toBe(join(process.cwd(), ".runtime/codex-app-server.sock"));
    expect(config.stateDatabasePath).toBe(join(process.cwd(), "data/gateway.sqlite3"));
    expect(config.telegramAllowedUserIds).toEqual(new Set([123, 456]));
    expect(config.telegramMessageFormat).toBe("html");
  });

  it("rejects noncanonical uppercase log levels", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      ...workspaceEnvironment(workdir),
      LOG_LEVEL: "INFO",
    })).toThrow(ConfigurationError);
  });

  it("rejects the removed Bridge sandbox setting", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      ...workspaceEnvironment(workdir),
      CODEX_BRIDGE_SANDBOX: "read-only",
    })).toThrow(
      "不支持配置项 CODEX_BRIDGE_SANDBOX；请运行 codexc doctor --fix，或手动改用 CODEX_SANDBOX",
    );
  });

  it("accepts Rich Messages as an explicit Telegram output format", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_MESSAGE_FORMAT: "rich",
      ...workspaceEnvironment(workdir),
    });

    expect(config.telegramMessageFormat).toBe("rich");
  });

  it("resolves an explicit state database path without treating it as Codex history", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    const stateDirectory = mkdtempSync(join(tmpdir(), "codex-gateway-state-"));
    temporaryDirectories.push(workdir, stateDirectory);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      ...workspaceEnvironment(workdir),
      STATE_DATABASE_PATH: join(stateDirectory, "bindings.sqlite3"),
    });

    expect(config.stateDatabasePath).toBe(join(stateDirectory, "bindings.sqlite3"));
  });

  it("rejects a missing workspace cwd without widening permissions", () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        ...workspaceEnvironment("/definitely/missing/codex-workdir"),
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects an existing file as a workspace cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(root);
    const file = join(root, "not-a-directory");
    writeFileSync(file, "test");

    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        ...workspaceEnvironment(file),
      }),
    ).toThrow("cwd 必须是目录");
  });

  it("rejects an unknown default workspace", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      CODEX_WORKSPACES_JSON: JSON.stringify([{ id: "main", name: "Main", cwd: workdir }]),
      CODEX_DEFAULT_WORKSPACE: "missing",
    })).toThrow("CODEX_DEFAULT_WORKSPACE 不存在");
  });

  it("prefers an explicit Telegram proxy and normalizes its URL", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_PROXY_URL: " http://127.0.0.1:7897 ",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ...workspaceEnvironment(workdir),
    });

    expect(config.telegramProxyUrl).toBe("http://127.0.0.1:7897/");
  });

  it("falls back to HTTPS_PROXY when no Telegram-specific proxy is configured", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ...workspaceEnvironment(workdir),
    });

    expect(config.telegramProxyUrl).toBe("http://127.0.0.1:7890/");
  });

  it("rejects proxy protocols unsupported by the Telegram HTTP client", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        TELEGRAM_PROXY_URL: "socks5://127.0.0.1:7890",
        ...workspaceEnvironment(workdir),
      }),
    ).toThrow("Telegram 代理目前只支持 http:// 或 https://");
  });

  it("re-reads an explicit environment file instead of stale process values", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);
    const envPath = join(workdir, ".env");
    writeFileSync(envPath, [
      "TELEGRAM_BOT_TOKEN=fresh-token",
      "TELEGRAM_ALLOWED_USER_IDS=456",
      `CODEX_WORKSPACES_JSON='${JSON.stringify([{ id: "main", name: "Main", cwd: workdir }])}'`,
      "CODEX_DEFAULT_WORKSPACE=main",
    ].join("\n"));

    const runtime = loadRuntimeConfig({
      CODEX_CONNECT_ENV_FILE: envPath,
      TELEGRAM_BOT_TOKEN: "stale-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      CODEX_MODEL: "stale-model",
      ...workspaceEnvironment(workdir),
    });

    expect(runtime.envPath).toBe(envPath);
    expect(runtime.config.telegramBotToken).toBe("fresh-token");
    expect(runtime.config.telegramAllowedUserIds).toEqual(new Set([456]));
    expect(runtime.config.codexModel).toBeUndefined();
  });
});

function workspaceEnvironment(cwd: string): Record<string, string> {
  return {
    CODEX_WORKSPACES_JSON: JSON.stringify([{ id: "main", name: "Main", cwd }]),
    CODEX_DEFAULT_WORKSPACE: "main",
  };
}
