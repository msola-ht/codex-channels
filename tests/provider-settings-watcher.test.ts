import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProviderSettingsWatcher,
  type ProviderSettingsWatcherOptions,
} from "../src/bootstrap/provider-settings-watcher.js";

const logger = pino({ level: "silent" });

describe("ProviderSettingsWatcher", () => {
  let codexHome: string;
  let connectHome: string;
  let restartCalls: string[];
  let stateEvents: string[];
  let active = false;
  let valid = true;
  let now = 0;
  let watcher: ProviderSettingsWatcher | undefined;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "provider-settings-watcher-"));
    connectHome = join(codexHome, ".codex-connect");
    mkdirSync(connectHome, { recursive: true, mode: 0o700 });
    restartCalls = [];
    stateEvents = [];
    active = false;
    valid = true;
    now = 0;
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(codexHome, { recursive: true, force: true });
  });

  const catalogPath = (): string =>
    join(connectHome, "providers", "opencode-go", "models.json");

  const writeCatalog = (content: string): void => {
    mkdirSync(dirname(catalogPath()), { recursive: true, mode: 0o700 });
    writeFileSync(catalogPath(), content);
  };

  const createWatcher = (
    options: Partial<ProviderSettingsWatcherOptions> = {},
  ): ProviderSettingsWatcher => {
    watcher = new ProviderSettingsWatcher({
      logger,
      hasActiveTurns: () => active,
      restartAppServer: async () => {
        restartCalls.push("restart");
      },
      onStateChange: (change) => {
        stateEvents.push(change.kind);
      },
      environment: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_CONNECT_HOME: connectHome,
      },
      pollIntervalMs: 60_000,
      restartCooldownMs: 0,
      validate: () => {
        if (!valid) {
          throw new Error("invalid settings");
        }
      },
      ...options,
    });
    watcher.start();
    return watcher;
  };

  it("启动时只建立基线，设置文件变化后只重启一次", async () => {
    const instance = createWatcher();
    await instance.checkNow();
    expect(restartCalls).toEqual([]);
    expect(stateEvents).toEqual([]);

    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);

    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);
  });

  it("校验失败时不更新基线，修复后触发重启", async () => {
    const instance = createWatcher();
    writeCatalog('{"models":[]}\n');
    valid = false;
    await instance.checkNow();
    expect(restartCalls).toEqual([]);
    expect(stateEvents).toEqual([]);

    valid = true;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);
  });

  it("校验失败在冷却窗口内只记录一次，修复后触发重启", async () => {
    const errors: string[] = [];
    const instance = createWatcher({
      logger: {
        error: (_payload: unknown, message?: string) => {
          errors.push(message ?? "");
        },
        info: () => undefined,
        warn: () => undefined,
      } as unknown as Logger,
      nowMs: () => now,
      validationCooldownMs: 30_000,
    });
    writeCatalog('{"models":[]}\n');
    valid = false;
    await instance.checkNow();
    expect(errors).toHaveLength(1);

    now = 1_000;
    await instance.checkNow();
    expect(errors).toHaveLength(1);

    valid = true;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
  });

  it("重启失败后的重试会先重新校验，配置仍无效时不重启", async () => {
    const errors: string[] = [];
    const instance = createWatcher({
      logger: {
        error: (_payload: unknown, message?: string) => {
          errors.push(message ?? "");
        },
        info: () => undefined,
        warn: () => undefined,
      } as unknown as Logger,
      nowMs: () => now,
      validationCooldownMs: 30_000,
      restartAppServer: async () => {
        restartCalls.push("restart");
        if (restartCalls.length === 1) {
          throw new Error("restart failed");
        }
      },
    });
    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "failed"]);

    now = 31_000;
    valid = false;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "failed"]);
    expect(errors.filter((message) => message.includes("校验失败"))).toHaveLength(1);

    valid = true;
    now = 62_000;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart", "restart"]);
    expect(stateEvents).toEqual([
      "scheduled",
      "restarting",
      "failed",
      "restarting",
      "applied",
    ]);
  });

  it("有活动 Turn 时推迟重启，空闲后自动重启", async () => {
    const instance = createWatcher();
    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    active = true;
    await instance.checkNow();
    expect(restartCalls).toEqual([]);
    expect(stateEvents).toEqual(["scheduled"]);

    active = false;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);
  });

  it("重启失败后保留待处理状态并在冷却后重试", async () => {
    const instance = createWatcher({
      restartAppServer: async () => {
        restartCalls.push("restart");
        if (restartCalls.length === 1) {
          throw new Error("restart failed");
        }
      },
    });
    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "failed"]);

    await instance.checkNow();
    expect(restartCalls).toEqual(["restart", "restart"]);
    expect(stateEvents).toEqual([
      "scheduled",
      "restarting",
      "failed",
      "restarting",
      "applied",
    ]);
  });

  it("停止后不再处理设置变化", async () => {
    const instance = createWatcher();
    instance.stop();
    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual([]);
    expect(stateEvents).toEqual([]);
  });
});
