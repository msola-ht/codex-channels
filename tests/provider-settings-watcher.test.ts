import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProviderSettingsWatcher,
  type ProviderSettingsWatcherOptions,
} from "../src/bootstrap/provider-settings-watcher.js";

const logger = pino({ level: "silent" });

describe("ProviderSettingsWatcher", () => {
  let codexHome: string;
  let restartCalls: string[];
  let active = false;
  let valid = true;
  let watcher: ProviderSettingsWatcher | undefined;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "provider-settings-watcher-"));
    restartCalls = [];
    active = false;
    valid = true;
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(codexHome, { recursive: true, force: true });
  });

  const catalogPath = (): string => join(codexHome, "sf-opencode-go.models.json");

  const createWatcher = (
    options: Partial<ProviderSettingsWatcherOptions> = {},
  ): ProviderSettingsWatcher => {
    watcher = new ProviderSettingsWatcher({
      logger,
      hasActiveTurns: () => active,
      restartAppServer: async () => {
        restartCalls.push("restart");
      },
      environment: { ...process.env, CODEX_HOME: codexHome },
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

    writeFileSync(catalogPath(), '{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);

    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
  });

  it("校验失败时不更新基线，修复后触发重启", async () => {
    const instance = createWatcher();
    writeFileSync(catalogPath(), '{"models":[]}\n');
    valid = false;
    await instance.checkNow();
    expect(restartCalls).toEqual([]);

    valid = true;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
  });

  it("有活动 Turn 时推迟重启，空闲后自动重启", async () => {
    const instance = createWatcher();
    writeFileSync(catalogPath(), '{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    active = true;
    await instance.checkNow();
    expect(restartCalls).toEqual([]);

    active = false;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
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
    writeFileSync(catalogPath(), '{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);

    await instance.checkNow();
    expect(restartCalls).toEqual(["restart", "restart"]);
  });

  it("停止后不再处理设置变化", async () => {
    const instance = createWatcher();
    instance.stop();
    writeFileSync(catalogPath(), '{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual([]);
  });
});
