import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProviderSettingsWatcher,
  type ProviderSettingsWatcherOptions,
} from "../src/bootstrap/provider-settings-watcher.js";
import { ModelSelectionService, type ModelOption, type ModelSelectionPort } from "../src/application/index.js";
import type { SessionRouter } from "../src/session-routing/index.js";
import {
  opencodeGoAccountMarkerPath,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";

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
    writeOpencodeGoAccounts({ CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome }, [
      { id: "main", default: true },
    ]);
  });

  afterEach(async () => {
    await watcher?.stop();
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
      applyProviderSettings: async () => {
        if (active) return false;
        restartCalls.push("restart");
        return true;
      },
      refreshProviderModels: () => undefined,
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

  it("两个Provider同时变化时只发布成功目标的目录，busy账户新会话保留旧默认", async () => {
    writeOpencodeGoAccounts({ CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome }, [
      { id: "main", default: false }, { id: "other", default: true },
    ]);
    const entry = (provider: string, name: string): ModelOption => ({
      provider, id: name, model: name, displayName: name, isDefault: true,
      supportedReasoningEfforts: [], defaultReasoningEffort: "high",
      serviceTiers: [], defaultServiceTier: null, inputModalities: ["text"],
    });
    const old = [entry("ocg-main", "a-old"), entry("ocg-other", "b-old")];
    const next = [entry("ocg-main", "a-new"), entry("ocg-other", "b-new")];
    const selection = new ModelSelectionService({ listModels: async () => [] } as unknown as ModelSelectionPort,
      { current: () => undefined, modelSettings: () => undefined } as unknown as SessionRouter,
      undefined, old, "openai", [], () => false, () => new Set(), "ocg-other");
    const fresh = { surface: "telegram" as const, accountId: "test", conversationId: "new" };
    const refresh = vi.fn((provider: string) => selection.updateSupplementaryModels(next, provider));
    const instance = createWatcher({ configuredProviders: ["ocg-main", "ocg-other"],
      applyProviderSettings: async provider => provider === "ocg-main", refreshProviderModels: refresh });
    writeCatalog("both changed");
    await instance.checkNow();
    expect(refresh.mock.calls.map(([provider]) => provider)).toEqual(["ocg-main"]);
    expect(selection.threadStartOptions(fresh)).toEqual({ model: "b-old", modelProvider: "ocg-other" });
    expect((await selection.state(fresh)).models.map(model => model.model)).toEqual(["b-old", "a-new"]);
    expect(stateEvents.filter(event => event === "applied")).toHaveLength(1);
  });

  it.each(["changed", "stopped"])("异步目录确认期间%s禁止迟到成功反馈", async (outcome) => {
    let finish!: () => void;
    let cancellation!: AbortSignal;
    const refresh = vi.fn(async (_provider: string, signal: AbortSignal) => {
      cancellation = signal;
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const instance = createWatcher({ refreshProviderModels: refresh, stopTimeoutMs: 0 });
    writeCatalog("first");
    const running = instance.checkNow();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    if (outcome === "changed") writeCatalog("new generation");
    else await instance.stop();
    finish();
    await running;
    expect(stateEvents).not.toContain("applied");
    expect(cancellation.aborted).toBe(outcome === "stopped");
  });

  it("模型刷新失败进入失败状态，冷却后无需再次修改文件即可恢复", async () => {
    now = 30_000;
    let refreshCalls = 0;
    let snapshot = "old";
    const appliedSnapshots: string[] = [];
    const instance = createWatcher({
      nowMs: () => now,
      restartCooldownMs: 30_000,
      refreshProviderModels: () => {
        refreshCalls += 1;
        expect(restartCalls).toHaveLength(refreshCalls);
        if (refreshCalls === 1) throw new Error("catalog read failed");
        snapshot = "new";
      },
      onStateChange: (change) => {
        if (change.kind === "applied") appliedSnapshots.push(snapshot);
        stateEvents.push(change.kind);
      },
    });
    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(stateEvents).toEqual(["scheduled", "restarting", "failed"]);
    expect(snapshot).toBe("old");
    expect(appliedSnapshots).toEqual([]);
    now = 59_000;
    await instance.checkNow();
    expect(refreshCalls).toBe(1);
    now = 61_000;
    await instance.checkNow();
    expect(refreshCalls).toBe(2);
    expect(stateEvents).toEqual(["scheduled", "restarting", "failed", "restarting", "applied"]);
    expect(snapshot).toBe("new");
    expect(appliedSnapshots).toEqual(["new"]);
    now = 92_000;
    await instance.checkNow();
    expect(refreshCalls).toBe(2);
  });

  it("启动时静默核对宿主已应用状态，设置文件变化后通知一次", async () => {
    const instance = createWatcher();
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual([]);

    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart", "restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);

    await instance.checkNow();
    expect(restartCalls).toEqual(["restart", "restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);
  });

  it("GO 多账户共享目录变化时只向状态事件列出实际账户并只重启一次", async () => {
    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    };
    writeOpencodeGoAccounts(environment, [
      { id: "main", default: true },
      { id: "lunare", default: false },
    ]);
    const scheduledProviders: string[][] = [];
    const instance = createWatcher({
      environment,
      onStateChange: (change) => {
        if (change.kind === "scheduled") scheduledProviders.push(change.providers);
      },
    });

    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();

    expect(restartCalls).toEqual(["restart", "restart"]);
    expect(scheduledProviders).toEqual([
      ["ocg-main", "ocg-lunare"],
    ]);
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

  it("设置文件暂时不可读时保留旧基线，修复后再触发重启", async () => {
    const errors: string[] = [];
    const instance = createWatcher({
      logger: {
        error: (_payload: unknown, message?: string) => {
          errors.push(message ?? "");
        },
        info: () => undefined,
        warn: () => undefined,
      } as unknown as Logger,
    });
    mkdirSync(catalogPath(), { recursive: true });

    expect(() => instance.checkNow()).not.toThrow();
    expect(restartCalls).toEqual([]);
    expect(stateEvents).toEqual([]);
    expect(errors).toEqual(["读取第三方模型设置失败，继续使用现有配置并等待修复"]);

    rmSync(catalogPath(), { recursive: true, force: true });
    writeCatalog('{"models":[{"slug":"deepseek-v4-flash"}]}\n');
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied"]);
  });

  it("合并 OpenCode Go 共享目录与账户标记，账户变更只触发一次 Provider 重启", async () => {
    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    };
    writeOpencodeGoAccounts(environment, [
      { id: "main", default: true },
      { id: "lunare", default: false },
    ]);
    const defaultMarkerPath = opencodeGoAccountMarkerPath(environment, "main");
    const accountMarkerPath = opencodeGoAccountMarkerPath(environment, "lunare");
    mkdirSync(dirname(defaultMarkerPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(accountMarkerPath), { recursive: true, mode: 0o700 });
    writeFileSync(defaultMarkerPath, 'version = 1\nprovider = "ocg-main"\n# default-v1\n', { mode: 0o600 });
    writeFileSync(accountMarkerPath, 'version = 1\nprovider = "ocg-lunare"\n# lunare-v1\n', { mode: 0o600 });

    const instance = createWatcher({ environment });
    writeFileSync(defaultMarkerPath, 'version = 1\nprovider = "ocg-main"\n# default-v2\n');
    writeFileSync(accountMarkerPath, 'version = 1\nprovider = "ocg-lunare"\n# lunare-v2\n');
    await instance.checkNow();

    expect(restartCalls).toEqual(["restart", "restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "applied", "restarting", "applied"]);
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
      applyProviderSettings: async () => {
        restartCalls.push("restart");
        if (restartCalls.length === 1) {
          throw new Error("restart failed");
        }
        return true;
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
    expect(stateEvents).toEqual(["scheduled", "restarting", "scheduled"]);
    await instance.checkNow();
    expect(stateEvents).toEqual(["scheduled", "restarting", "scheduled"]);

    active = false;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual(["scheduled", "restarting", "scheduled", "restarting", "applied"]);
  });

  it("重启失败后保留待处理状态并在冷却后重试", async () => {
    const instance = createWatcher({
      applyProviderSettings: async () => {
        restartCalls.push("restart");
        if (restartCalls.length === 1) {
          throw new Error("restart failed");
        }
        return true;
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

  it("只应用当前Gateway启用的Provider，连续变化不覆盖另一Provider待应用项", async () => {
    const environment = { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
    writeOpencodeGoAccounts(environment, [{ id: "main", default: true }, { id: "other", default: false }]);
    const applied: string[] = [];
    const instance = createWatcher({
      configuredProviders: ["ocg-main"],
      applyProviderSettings: async (provider) => { applied.push(provider); return false; },
    });
    writeCatalog("first");
    await instance.checkNow();
    const otherMarker = opencodeGoAccountMarkerPath(environment, "other");
    mkdirSync(dirname(otherMarker), { recursive: true });
    writeFileSync(otherMarker, "other-change");
    await instance.checkNow();
    expect(applied).toEqual(["ocg-main", "ocg-main"]);
    expect(stateEvents).not.toContain("applied");
  });

  it.each(["success", "failure", "invalid"])("应用期间再次变更保留最新代次：%s", async (outcome) => {
    let finish!: (value: boolean) => void;
    let fail!: (reason: Error) => void;
    const first = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
    const apply = vi.fn().mockReturnValueOnce(first).mockResolvedValue(true);
    const refresh = vi.fn();
    const instance = createWatcher({ applyProviderSettings: apply, refreshProviderModels: refresh });
    writeCatalog("first");
    const running = instance.checkNow();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    writeCatalog("second");
    if (outcome === "invalid") valid = false;
    void instance.checkNow();
    if (outcome === "failure") fail(new Error("failed"));
    else finish(true);
    await running;
    expect(stateEvents).not.toContain("applied");
    expect(refresh).not.toHaveBeenCalled();
    valid = true;
    await instance.checkNow();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(stateEvents.filter((state) => state === "applied")).toHaveLength(1);
  });

  it("停止取消在途应用并禁止迟到刷新和状态确认", async () => {
    let finish!: (value: boolean) => void;
    let signal: AbortSignal | undefined;
    const refresh = vi.fn();
    const instance = createWatcher({
      stopTimeoutMs: 0,
      applyProviderSettings: async (_provider, cancellation) => {
        signal = cancellation;
        return new Promise<boolean>((resolve) => { finish = resolve; });
      },
      refreshProviderModels: refresh,
    });
    writeCatalog("first");
    const running = instance.checkNow();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await instance.stop();
    expect(signal?.aborted).toBe(true);
    const before = [...stateEvents];
    finish(true);
    await running;
    expect(stateEvents).toEqual(before);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("宿主仍busy的待生效设置在Gateway重建后继续静默等待", async () => {
    writeCatalog("saved-before-gateway-start");
    active = true;
    const instance = createWatcher();
    await instance.checkNow();
    expect(restartCalls).toEqual([]);
    expect(stateEvents).toEqual([]);
    active = false;
    await instance.checkNow();
    expect(restartCalls).toEqual(["restart"]);
    expect(stateEvents).toEqual([]);
  });

  it("每Provider每文件代次失败最多12次，新变化重置预算", async () => {
    const apply = vi.fn(async (): Promise<boolean> => { throw new Error("failed"); });
    const instance = createWatcher({ applyProviderSettings: apply });
    writeCatalog("first");
    for (let attempt = 0; attempt < 14; attempt += 1) await instance.checkNow();
    expect(apply).toHaveBeenCalledTimes(12);
    writeCatalog("second");
    await instance.checkNow();
    expect(apply).toHaveBeenCalledTimes(13);
  });

  it("固定模式监听主config，修改时只应用固定Provider而不影响切换账户", async () => {
    const environment = { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome };
    writeOpencodeGoAccounts(environment, [{ id: "main", default: true }, { id: "other", default: false }]);
    const marker = opencodeGoAccountMarkerPath(environment, "main");
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, 'version = 1\nprovider = "ocg-main"\nmode = "exclusive"\n', { mode: 0o600 });
    const config = join(codexHome, "config.toml");
    writeFileSync(config, 'model = "first"\n', { mode: 0o600 });
    const applied: string[] = [];
    const instance = createWatcher({ applyProviderSettings: async (provider) => { applied.push(provider); return true; } });
    await instance.checkNow();
    applied.length = 0;
    writeFileSync(config, 'model = "second"\n');
    await instance.checkNow();
    expect(applied).toEqual(["ocg-main"]);
  });
});
