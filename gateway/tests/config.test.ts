import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("accepts legacy uppercase log levels and derives an absolute socket path", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123,456",
      CODEX_WORKDIR: workdir,
      LOG_LEVEL: "INFO",
    });

    expect(config.logLevel).toBe("info");
    expect(config.codexWorkdir).toBe(realpathSync(workdir));
    expect(config.codexSocketPath).toBe(join(realpathSync(workdir), ".runtime/codex-app-server.sock"));
    expect(config.telegramAllowedUserIds).toEqual(new Set([123, 456]));
  });

  it("rejects a missing workdir without widening permissions", () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        CODEX_WORKDIR: "/definitely/missing/codex-workdir",
      }),
    ).toThrow(ConfigurationError);
  });

  it("prefers an explicit Telegram proxy and normalizes its URL", () => {
    const workdir = mkdtempSync(join(tmpdir(), "codex-gateway-config-"));
    temporaryDirectories.push(workdir);

    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_PROXY_URL: " http://127.0.0.1:7897 ",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      CODEX_WORKDIR: workdir,
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
      CODEX_WORKDIR: workdir,
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
        CODEX_WORKDIR: workdir,
      }),
    ).toThrow("Telegram 代理目前只支持 http:// 或 https://");
  });
});
