import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config/index.js";

const mocks = vi.hoisted(() => ({
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  loadRuntimeConfig: vi.fn(),
  createWeixinCredentialStore: vi.fn(),
  createWeixinCredentialChangeCheck: vi.fn(),
  weixinCredentialsChanged: vi.fn(),
  configEventQueuePath: vi.fn(() => "/tmp/config-events.jsonl"),
  readConfigEvents: vi.fn(),
  matchingWorkspaceConfigEvents: vi.fn(),
  acknowledgeConfigEvents: vi.fn(),
  createLogger: vi.fn(),
  createOwner: vi.fn(),
  createApplication: vi.fn(),
  createAccountRefresh: vi.fn(),
  createProviderSettingsWatcher: vi.fn(),
  createNetworkProxyWatcher: vi.fn(),
  readCodexProxySettings: vi.fn(),
  restartAppServerService: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  owner: {
    start: vi.fn(),
    close: vi.fn(),
    markReady: vi.fn(),
    markNotReady: vi.fn(),
  },
  application: {
    start: vi.fn(),
    stop: vi.fn(),
    reloadConfig: vi.fn(),
    refreshAccountSnapshot: vi.fn(),
    refreshProviderModels: vi.fn(),
    hasActiveTurns: vi.fn(),
    notifyProviderSettingsChange: vi.fn(),
    notifyConfigReloadFailure: vi.fn(),
    deliverAddedWorkspaceNotifications: vi.fn(),
  },
  accountRefresh: {
    start: vi.fn(),
    close: vi.fn(),
  },
  providerSettingsWatcher: {
    start: vi.fn(),
    stop: vi.fn(),
  },
  networkProxyWatcher: {
    start: vi.fn(),
    stop: vi.fn(),
  },
  providerSettingsOptions: undefined as undefined | {
    refreshProviderModels(): void;
    onStateChange(change: { kind: string; providers: string[] }): void;
  },
}));

vi.mock("node:fs", () => ({
  watchFile: mocks.watchFile,
  unwatchFile: mocks.unwatchFile,
}));
vi.mock("../runtime/config-event-queue.mjs", () => ({
  acknowledgeConfigEvents: mocks.acknowledgeConfigEvents,
  configEventQueuePath: mocks.configEventQueuePath,
  matchingWorkspaceConfigEvents: mocks.matchingWorkspaceConfigEvents,
  readConfigEvents: mocks.readConfigEvents,
}));
vi.mock("../runtime/gateway-account-refresh.mjs", () => ({
  GatewayAccountRefreshServer: class {
    constructor(...args: unknown[]) {
      return mocks.createAccountRefresh(...args);
    }
  },
}));
vi.mock("../runtime/gateway-owner.mjs", () => ({
  GatewayOwner: class {
    constructor(...args: unknown[]) {
      return mocks.createOwner(...args);
    }
  },
}));
vi.mock("../runtime/codex-proxy-env.mjs", () => ({
  readCodexProxySettings: mocks.readCodexProxySettings,
}));
vi.mock("../src/config/index.js", () => ({
  loadRuntimeConfig: mocks.loadRuntimeConfig,
}));
vi.mock("../src/observability/index.js", () => ({
  createLogger: mocks.createLogger,
}));
vi.mock("../src/surfaces/index.js", () => ({
  createWeixinCredentialStore: mocks.createWeixinCredentialStore,
  createWeixinCredentialChangeCheck: mocks.createWeixinCredentialChangeCheck,
}));
vi.mock("../src/bootstrap/app.js", () => ({
  GatewayApplication: class {
    constructor(...args: unknown[]) {
      return mocks.createApplication(...args);
    }
  },
}));
vi.mock("../src/bootstrap/provider-settings-watcher.js", () => ({
  ProviderSettingsWatcher: class {
    constructor(options: typeof mocks.providerSettingsOptions) {
      mocks.providerSettingsOptions = options;
      return mocks.createProviderSettingsWatcher(options);
    }
  },
}));
vi.mock("../src/bootstrap/network-proxy-watcher.js", () => ({
  NetworkProxyWatcher: class {
    constructor(...args: unknown[]) {
      return mocks.createNetworkProxyWatcher(...args);
    }
  },
}));
vi.mock("../src/bootstrap/service-restart-runner.js", () => ({
  restartAppServerService: mocks.restartAppServerService,
}));

const { runGatewayProcess } = await import("../src/bootstrap/config-lifecycle.js");

const runtime = {
  configPath: "/tmp/codex-connect/config.toml",
  config: {
    workspaces: [{ id: "main", name: "Main", cwd: "/workspace" }],
    networkProxy: {},
  },
};

let originalSupervised: string | undefined;
let originalServiceRole: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalSupervised = process.env.CODEX_CONNECT_GATEWAY_SUPERVISED;
  originalServiceRole = process.env.CODEX_CONNECT_SERVICE_ROLE;
  delete process.env.CODEX_CONNECT_GATEWAY_SUPERVISED;
  delete process.env.CODEX_CONNECT_SERVICE_ROLE;
  mocks.providerSettingsOptions = undefined;
  mocks.loadRuntimeConfig.mockReturnValue(runtime);
  mocks.createWeixinCredentialChangeCheck.mockResolvedValue(mocks.weixinCredentialsChanged);
  mocks.weixinCredentialsChanged.mockResolvedValue("unchanged");
  mocks.readConfigEvents.mockReturnValue([]);
  mocks.matchingWorkspaceConfigEvents.mockReturnValue([]);
  mocks.createLogger.mockReturnValue(mocks.logger);
  mocks.createOwner.mockReturnValue(mocks.owner);
  mocks.createApplication.mockReturnValue(mocks.application);
  mocks.createAccountRefresh.mockReturnValue(mocks.accountRefresh);
  mocks.createProviderSettingsWatcher.mockReturnValue(mocks.providerSettingsWatcher);
  mocks.createNetworkProxyWatcher.mockReturnValue(mocks.networkProxyWatcher);
  mocks.readCodexProxySettings.mockReturnValue({});
  mocks.owner.start.mockResolvedValue(undefined);
  mocks.owner.close.mockResolvedValue(undefined);
  mocks.application.start.mockResolvedValue(undefined);
  mocks.application.stop.mockResolvedValue(undefined);
  mocks.application.reloadConfig.mockReturnValue({ action: "reload", changes: [] });
  mocks.application.hasActiveTurns.mockReturnValue(false);
  mocks.application.deliverAddedWorkspaceNotifications.mockResolvedValue(undefined);
  mocks.accountRefresh.start.mockResolvedValue(undefined);
  mocks.accountRefresh.close.mockResolvedValue(undefined);
  mocks.restartAppServerService.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  if (originalSupervised === undefined) {
    delete process.env.CODEX_CONNECT_GATEWAY_SUPERVISED;
  } else {
    process.env.CODEX_CONNECT_GATEWAY_SUPERVISED = originalSupervised;
  }
  if (originalServiceRole === undefined) {
    delete process.env.CODEX_CONNECT_SERVICE_ROLE;
  } else {
    process.env.CODEX_CONNECT_SERVICE_ROLE = originalServiceRole;
  }
  vi.restoreAllMocks();
});

describe("runGatewayProcess", () => {
  it("applies the gateway timezone before constructing application components", async () => {
    isolateProcessLifecycle();
    vi.stubEnv("TZ", "UTC");
    mocks.loadRuntimeConfig.mockReturnValue({
      ...runtime, config: { ...runtime.config, gatewayTimezone: "Asia/Shanghai" },
    });
    mocks.createLogger.mockImplementation(() => {
      expect(process.env.TZ).toBe("Asia/Shanghai");
      return mocks.logger;
    });
    await runGatewayProcess();
    expect(process.env.TZ).toBe("Asia/Shanghai");
  });

  it("acquires ownership, starts components, watches config, and marks ready in order", async () => {
    const processHandlers = isolateProcessLifecycle();
    const watchedPaths: string[] = [];
    mocks.watchFile.mockImplementation((path: string) => {
      watchedPaths.push(path);
    });
    const pending = [{ id: "event-1", workspace: "docs" }];
    mocks.readConfigEvents.mockReturnValue(pending);
    mocks.matchingWorkspaceConfigEvents.mockReturnValue(pending);

    await runGatewayProcess();

    expect(mocks.owner.start).toHaveBeenCalledOnce();
    expect(mocks.application.start).toHaveBeenCalledOnce();
    expect(mocks.accountRefresh.start).toHaveBeenCalledOnce();
    expect(mocks.owner.markReady).toHaveBeenCalledOnce();
    expect(mocks.providerSettingsWatcher.start).toHaveBeenCalledOnce();
    expect(mocks.networkProxyWatcher.start).toHaveBeenCalledOnce();
    expect(watchedPaths).toEqual([
      runtime.configPath,
      "/tmp/config-events.jsonl",
    ]);
    expect(mocks.application.reloadConfig).toHaveBeenCalledWith(
      runtime.config,
      ["docs"],
      false,
    );
    expect(mocks.application.deliverAddedWorkspaceNotifications)
      .toHaveBeenCalledWith(["docs"]);
    expect(mocks.acknowledgeConfigEvents)
      .toHaveBeenCalledWith("/tmp/config-events.jsonl", ["event-1"]);
    expect(processHandlers.has("SIGHUP")).toBe(true);
    expect(mocks.owner.start.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.application.start.mock.invocationCallOrder[0]!);
    expect(mocks.application.start.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.accountRefresh.start.mock.invocationCallOrder[0]!);
    expect(mocks.accountRefresh.start.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.owner.markReady.mock.invocationCallOrder[0]!);
  });

  it("maps Provider settings states to shared Surface notifications", async () => {
    isolateProcessLifecycle();
    await runGatewayProcess();

    mocks.providerSettingsOptions?.onStateChange({
      kind: "restarting",
      providers: ["deepseek"],
    });

    expect(mocks.application.notifyProviderSettingsChange).toHaveBeenCalledWith(
      "provider-settings-restarting",
      ["deepseek"],
    );
  });

  it("forwards Provider model refresh failures to the watcher application path", async () => {
    isolateProcessLifecycle();
    await runGatewayProcess();
    const error = new Error("catalog read failed");
    mocks.application.refreshProviderModels.mockImplementationOnce(() => { throw error; });
    expect(() => mocks.providerSettingsOptions!.refreshProviderModels()).toThrow(error);
    mocks.providerSettingsOptions!.refreshProviderModels();
    expect(mocks.application.refreshProviderModels).toHaveBeenCalledTimes(2);
    expect(mocks.application.notifyProviderSettingsChange).not.toHaveBeenCalled();
  });

  it("retains unreadable config events and continues with the current configuration", async () => {
    isolateProcessLifecycle();
    mocks.readConfigEvents.mockImplementation(() => {
      throw new Error("unreadable queue");
    });

    await expect(runGatewayProcess()).resolves.toBeUndefined();

    expect(mocks.application.reloadConfig).toHaveBeenCalledWith(runtime.config, [], false);
    expect(mocks.acknowledgeConfigEvents).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "读取配置事件队列失败；事件将保留以便后续重试",
    );
  });

  it("closes every initialized component when application startup fails", async () => {
    isolateProcessLifecycle();
    mocks.application.start.mockRejectedValueOnce(new Error("start failed"));

    await expect(runGatewayProcess()).rejects.toThrow("start failed");

    expect(mocks.accountRefresh.close).toHaveBeenCalledOnce();
    expect(mocks.application.stop).toHaveBeenCalledOnce();
    expect(mocks.owner.close).toHaveBeenCalledOnce();
    expect(mocks.owner.markReady).not.toHaveBeenCalled();
    expect(mocks.providerSettingsWatcher.start).not.toHaveBeenCalled();
    expect(mocks.networkProxyWatcher.start).not.toHaveBeenCalled();
  });

  it("closes ownership when application construction fails", async () => {
    isolateProcessLifecycle();
    mocks.createApplication.mockImplementationOnce(() => {
      throw new Error("construct failed");
    });

    await expect(runGatewayProcess()).rejects.toThrow("construct failed");

    expect(mocks.owner.close).toHaveBeenCalledOnce();
    expect(mocks.accountRefresh.start).not.toHaveBeenCalled();
  });

  it("stops with the supervised restart code after a debounced reload", async () => {
    vi.useFakeTimers();
    process.env.CODEX_CONNECT_GATEWAY_SUPERVISED = "1";
    const processHandlers = isolateProcessLifecycle();
    mocks.application.reloadConfig
      .mockReturnValueOnce({ action: "reload", changes: [] })
      .mockReturnValueOnce({
        action: "restart",
        changes: [{ code: "codex.default-model" }],
      });
    await runGatewayProcess();

    processHandlers.get("SIGHUP")?.();
    await vi.advanceTimersByTimeAsync(150);
    await settlePromises();

    expect(mocks.owner.markNotReady).toHaveBeenCalledOnce();
    expect(mocks.providerSettingsWatcher.stop).toHaveBeenCalledOnce();
    expect(mocks.networkProxyWatcher.stop).toHaveBeenCalledOnce();
    expect(mocks.accountRefresh.close).toHaveBeenCalledOnce();
    expect(mocks.application.stop).toHaveBeenCalledOnce();
    expect(mocks.owner.close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(75);
  });

  it("checks same-account credentials on config reload and restarts the supervised Gateway", async () => {
    vi.useFakeTimers();
    process.env.CODEX_CONNECT_GATEWAY_SUPERVISED = "1";
    const processHandlers = isolateProcessLifecycle();
    const config = { ...runtime.config, credentialsDirectory: "/tmp/credentials",
      weixin: { accountId: "bot@im.bot" } };
    mocks.loadRuntimeConfig.mockReturnValue({ ...runtime, config });
    mocks.application.reloadConfig.mockImplementation((_next, _events, changed) => ({
      action: changed ? "restart" : "reload", changes: [],
    }));
    await runGatewayProcess();
    expect(mocks.application.reloadConfig).toHaveBeenLastCalledWith(config, [], false);
    mocks.weixinCredentialsChanged.mockResolvedValue("changed");
    processHandlers.get("SIGHUP")?.();
    await vi.advanceTimersByTimeAsync(150);
    await settlePromises();
    expect(mocks.application.reloadConfig).toHaveBeenLastCalledWith(config, [], true);
    expect(mocks.application.stop).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(75);
  });

  it.each([false, true])("isolates secure-store failures and still applies config before credential recovery (startup failure: %s)", async (startupFailure) => {
    vi.useFakeTimers();
    process.env.CODEX_CONNECT_GATEWAY_SUPERVISED = "1";
    const handlers = isolateProcessLifecycle();
    const { createWeixinCredentialChangeCheck } = await vi.importActual<
      typeof import("../src/surfaces/weixin/credential-client.js")
    >("../src/surfaces/weixin/credential-client.js");
    const { classifyConfigReload } = await vi.importActual<
      typeof import("../src/config/reload-classifier.js")
    >("../src/config/reload-classifier.js");
    let failed = startupFailure;
    let botToken = "old-fixture";
    mocks.createWeixinCredentialStore.mockReturnValue({ get: async () => {
      if (failed) throw new Error("private credential error");
      return { version: 1, accountId: "bot@im.bot", botToken,
        baseUrl: "https://ilinkai.weixin.qq.com", grantedAt: 1 };
    } });
    mocks.createWeixinCredentialChangeCheck.mockImplementationOnce(createWeixinCredentialChangeCheck);
    const config = { ...runtime.config, credentialsDirectory: "/tmp/credentials",
      telegramEnabled: true, telegramAllowedUserIds: new Set([123]),
      weixin: { accountId: "bot@im.bot", allowedUserIds: new Set(["actor@im.wechat"]) } } as unknown as GatewayConfig;
    mocks.loadRuntimeConfig.mockReturnValue({ ...runtime, config });
    // Use the real credential comparison and reload decision while isolating processes and platform I/O.
    mocks.application.reloadConfig.mockImplementation((next, _events, changed) =>
      classifyConfigReload(config, next, changed));
    await runGatewayProcess();
    expect(mocks.application.start).toHaveBeenCalledOnce();
    expect(mocks.owner.markReady).toHaveBeenCalledOnce();
    failed = true;
    const next = { ...config, telegramAllowedUserIds: new Set([123, 456]) };
    mocks.loadRuntimeConfig.mockReturnValue({ ...runtime, config: next });
    handlers.get("SIGHUP")?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(mocks.application.reloadConfig).toHaveBeenLastCalledWith(next, [], false);
    expect(mocks.application.reloadConfig.mock.results.at(-1)?.value).toEqual({
      action: "reload", changes: [{ code: "surface.telegram.allowed-users", scope: "telegram" }],
    });
    expect(mocks.application.stop).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith({ surface: "weixin" }, expect.stringContaining("凭据检查失败"));
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain("private credential error");
    failed = false;
    botToken = "new-fixture";
    handlers.get("SIGHUP")?.();
    await vi.advanceTimersByTimeAsync(150);
    await settlePromises();
    expect(mocks.application.reloadConfig).toHaveBeenLastCalledWith(next, [], true);
    expect(process.exit).toHaveBeenCalledWith(75);
  });

  it.each([false, true])("does not apply a credential reload after shutdown starts (read fails: %s)", async (readFails) => {
    vi.useFakeTimers();
    const processHandlers = isolateProcessLifecycle();
    mocks.loadRuntimeConfig.mockReturnValue({ ...runtime, config: {
      ...runtime.config, credentialsDirectory: "/tmp/credentials", weixin: { accountId: "bot@im.bot" },
    } });
    await runGatewayProcess();
    let finishRead!: (changed: string) => void;
    mocks.weixinCredentialsChanged.mockImplementationOnce(() => new Promise<string>((resolve, reject) => {
      finishRead = (changed) => readFails ? reject(new Error("read failed")) : resolve(changed);
    }));
    processHandlers.get("SIGHUP")?.();
    await vi.advanceTimersByTimeAsync(150);
    processHandlers.get("SIGTERM")?.();
    finishRead("changed");
    await settlePromises();
    expect(mocks.application.reloadConfig).toHaveBeenCalledOnce();
    expect(mocks.application.notifyConfigReloadFailure).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("keeps the current process running when a debounced reload fails", async () => {
    vi.useFakeTimers();
    const processHandlers = isolateProcessLifecycle();
    await runGatewayProcess();
    mocks.loadRuntimeConfig.mockImplementationOnce(() => {
      throw new Error("invalid replacement config");
    });

    processHandlers.get("SIGHUP")?.();
    await vi.advanceTimersByTimeAsync(150);
    await settlePromises();

    expect(mocks.application.notifyConfigReloadFailure).toHaveBeenCalledOnce();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Gateway 配置热加载失败，继续使用现有配置",
    );
    expect(mocks.owner.markNotReady).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("retains config events when their Surface notification fails", async () => {
    isolateProcessLifecycle();
    const pending = [{ id: "event-1", workspace: "docs" }];
    mocks.readConfigEvents.mockReturnValue(pending);
    mocks.matchingWorkspaceConfigEvents.mockReturnValue(pending);
    mocks.application.deliverAddedWorkspaceNotifications
      .mockRejectedValueOnce(new Error("delivery failed"));

    await expect(runGatewayProcess()).resolves.toBeUndefined();

    expect(mocks.acknowledgeConfigEvents).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), events: 1 }),
      "配置事件投递或确认失败；事件已保留，等待下次配置加载",
    );
  });

  it("stops only once when the parent repeats its stop request", async () => {
    const processHandlers = isolateProcessLifecycle();
    await runGatewayProcess();

    processHandlers.get("message")?.({ type: "codexc-stop" });
    processHandlers.get("message")?.({ type: "codexc-stop" });
    await settlePromises();

    expect(mocks.owner.markNotReady).toHaveBeenCalledOnce();
    expect(mocks.accountRefresh.close).toHaveBeenCalledOnce();
    expect(mocks.application.stop).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});

function isolateProcessLifecycle(): Map<string, (...args: unknown[]) => void> {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    handlers.set(String(event), listener as (...args: unknown[]) => void);
    return process;
  });
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    handlers.set(String(event), listener as (...args: unknown[]) => void);
    return process;
  });
  vi.spyOn(process, "removeListener").mockImplementation(() => process);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  return handlers;
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
