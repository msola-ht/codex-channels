import { describe, expect, it, vi } from "vitest";

import { ProviderIdleReleaser } from "../src/bootstrap/provider-idle-releaser.js";

function conversationTarget(surface: string, conversationId: string) {
  return { surface, accountId: "account", conversationId };
}

describe("ProviderIdleReleaser", () => {
  it("releases an idle GO account and notifies recent targets once", async () => {
    const released: string[] = [];
    const notified: Array<{ provider: string; targets: unknown[] }> = [];
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go-main", "opencode-go-b"],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => "opencode-go-main",
      notify: (provider, targets) => notified.push({ provider, targets: [...targets] }),
      idleThresholdMs: 60_000,
      nowMs: now,
    });
    const target = conversationTarget("telegram", "c1");
    releaser.touch("opencode-go-b", target);
    nowMs += 120_000;

    await releaser.scan();

    expect(released).toEqual(["opencode-go-b"]);
    expect(notified).toEqual([{
      provider: "opencode-go-b",
      targets: [target],
    }]);
  });

  it("skips launching, default-role, bound and recently active accounts", async () => {
    const released: string[] = [];
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const binding = {
      target: conversationTarget("telegram", "bound"),
      workspaceId: "w",
      threadId: "thread-bound",
      sessionId: "session",
    };
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => [
        "opencode-go-launching",
        "opencode-go-default",
        "opencode-go-bound",
        "opencode-go-recent",
        "opencode-go-idle",
      ],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: (threadId) =>
        threadId === "thread-bound" ? "opencode-go-bound" : undefined,
      listBindings: () => [binding],
      defaultRoleProvider: () => "opencode-go-default",
      notify: () => undefined,
      idleThresholdMs: 60_000,
      nowMs: now,
    });
    releaser.markLaunching("opencode-go-launching");
    releaser.touch("opencode-go-idle", conversationTarget("telegram", "i"));
    nowMs += 30_000;
    releaser.touch("opencode-go-recent", conversationTarget("telegram", "r"));
    nowMs += 31_000;

    await releaser.scan();

    expect(released).toEqual(["opencode-go-idle"]);
  });

  it("keeps the same account running while a binding exists even after threshold", async () => {
    const released: string[] = [];
    const binding = {
      target: conversationTarget("feishu", "bound"),
      workspaceId: "w",
      threadId: "thread-bound",
      sessionId: "session",
    };
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go"],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => "opencode-go",
      listBindings: () => [binding],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 0,
      nowMs: () => 1_000,
    });

    await releaser.scan();

    expect(released).toEqual([]);
  });

  it("releases an account after its launch has finished and it becomes idle", async () => {
    const released: string[] = [];
    let nowMs = 1_000;
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go-b"],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 60_000,
      nowMs: () => nowMs,
    });
    releaser.markLaunching("opencode-go-b");
    releaser.finishLaunching("opencode-go-b");
    nowMs += 60_001;

    await releaser.scan();

    expect(released).toEqual(["opencode-go-b"]);
  });

  it("skips a busy Provider without making the idle scan wait for its activity", async () => {
    let finishActivity!: () => void;
    const activityGate = new Promise<void>((resolve) => {
      finishActivity = resolve;
    });
    const released: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go-b"],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 60_000,
      nowMs: () => 1_000_000,
    });

    const activity = releaser.runActivity("opencode-go-b", () => activityGate);
    await Promise.resolve();
    const scan = releaser.scan();
    const scanSettled = vi.fn();
    void scan.then(scanSettled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(released).toEqual([]);
    expect(scanSettled).toHaveBeenCalledOnce();

    finishActivity();
    await Promise.all([activity, scan]);
    expect(released).toEqual([]);
  });

  it("does not make shutdown wait for an unrelated Provider activity", async () => {
    let finishActivity!: () => void;
    const activityGate = new Promise<void>((resolve) => {
      finishActivity = resolve;
    });
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go-b"],
      releaseProvider: async () => true,
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 0,
      nowMs: () => 1_000_000,
    });

    const activity = releaser.runActivity("opencode-go-b", () => activityGate);
    await Promise.resolve();
    const scan = releaser.scan();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stop = releaser.stop();
    const stopSettled = vi.fn();
    void stop.then(stopSettled);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopSettled).toHaveBeenCalledOnce();
    finishActivity();
    await Promise.all([activity, scan, stop]);
  });

  it("protects a read operation from release without refreshing its idle time", async () => {
    const released: string[] = [];
    let nowMs = 1_000;
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go-b"],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 60_000,
      nowMs: () => nowMs,
    });
    await releaser.runActivity("opencode-go-b", async () => undefined);
    nowMs += 60_001;

    await releaser.runOperation("opencode-go-b", async () => undefined);
    await releaser.scan();

    expect(released).toEqual(["opencode-go-b"]);
  });

  it("queues new Provider activity until an in-flight release has finished", async () => {
    let reportReleaseStarted!: () => void;
    let finishRelease!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      reportReleaseStarted = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    let activityStarted = false;
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: async () => ["opencode-go-b"],
      releaseProvider: async () => {
        reportReleaseStarted();
        await releaseGate;
        return true;
      },
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 0,
      nowMs: () => 1_000_000,
    });

    const scan = releaser.scan();
    await releaseStarted;
    const activity = releaser.runActivity("opencode-go-b", async () => {
      activityStarted = true;
    });
    await Promise.resolve();
    expect(activityStarted).toBe(false);

    finishRelease();
    await Promise.all([scan, activity]);
    expect(activityStarted).toBe(true);
  });

  it("waits for an in-flight scan and prevents releases after stop begins", async () => {
    let resolveRunning!: (providers: readonly string[]) => void;
    const running = new Promise<readonly string[]>((resolve) => {
      resolveRunning = resolve;
    });
    const released: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      isAccountProvider: (provider) => provider.startsWith("opencode-go"),
      listRunningProviders: () => running,
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => undefined,
      listBindings: () => [],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 0,
      nowMs: () => 1_000,
    });

    const scan = releaser.scan();
    const stop = releaser.stop();
    resolveRunning(["opencode-go-b"]);
    await Promise.all([scan, stop]);

    expect(released).toEqual([]);
  });
});

function silentLogger(): import("pino").Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import("pino").Logger;
}
