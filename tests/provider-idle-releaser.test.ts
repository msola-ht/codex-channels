import { describe, expect, it, vi } from "vitest";

import { ProviderIdleReleaser } from "../src/bootstrap/provider-idle-releaser.js";

const binding = {
  target: { surface: "telegram", accountId: "account", conversationId: "bound" },
  workspaceId: "workspace",
  threadId: "thread",
  sessionId: "session",
};

describe("ProviderIdleReleaser", () => {
  it("closes every Client and stops its App Server when the Gateway has no bindings", async () => {
    const events: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai", "deepseek"],
      closeProvider: async (provider) => {
        events.push(`close:${provider}`);
      },
      releaseProvider: async (provider) => {
        events.push(`release:${provider}`);
      },
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    await releaser.closeIfIdle();

    expect(events).toEqual([
      "close:openai",
      "close:deepseek",
      "release:openai",
      "release:deepseek",
    ]);
  });

  it("stops a running App Server that has no connected Client", async () => {
    const released: string[] = [];
    const closeProvider = vi.fn(async () => undefined);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => [],
      closeProvider,
      releaseProvider: async (provider) => {
        released.push(provider);
      },
      listReleasableAppServers: async () => ["ocg-main"],
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    await releaser.closeIfIdle();

    expect(closeProvider).not.toHaveBeenCalled();
    expect(released).toEqual(["ocg-main"]);
  });

  it("rechecks idle App Servers periodically", async () => {
    vi.useFakeTimers();
    const released: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => [],
      closeProvider: async () => undefined,
      releaseProvider: async (provider) => {
        released.push(provider);
      },
      listReleasableAppServers: async () => ["openai"],
      listBindings: () => [],
      gracePeriodMs: 0,
    });
    try {
      releaser.start();
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(released).toEqual(["openai"]);
    } finally {
      await releaser.stop();
      vi.useRealTimers();
    }
  });

  it("keeps releasing other App Servers when one stop fails", async () => {
    const released: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai", "deepseek"],
      closeProvider: async () => undefined,
      releaseProvider: async (provider) => {
        released.push(provider);
        if (provider === "openai") throw new Error("stop failed");
      },
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    await releaser.closeIfIdle();

    expect(released).toEqual(["openai", "deepseek"]);
  });

  it("keeps all Provider Clients running while any foreground or background binding exists", async () => {
    const closeProvider = vi.fn(async () => undefined);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai", "deepseek"],
      closeProvider,
      listBindings: () => [binding],
      gracePeriodMs: 0,
    });

    await releaser.closeIfIdle();

    expect(closeProvider).not.toHaveBeenCalled();
  });

  it("does not close Clients while a Provider operation is active", async () => {
    let finishActivity!: () => void;
    const activityGate = new Promise<void>((resolve) => {
      finishActivity = resolve;
    });
    const closeProvider = vi.fn(async () => undefined);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    const activity = releaser.runActivity("openai", () => activityGate);
    await releaser.closeIfIdle();
    expect(closeProvider).not.toHaveBeenCalled();

    finishActivity();
    await activity;
    await releaser.closeIfIdle();
    expect(closeProvider).toHaveBeenCalledWith("openai");
    await releaser.stop();
  });

  it("queues new Provider activity until a global Client close finishes", async () => {
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    let activityStarted = false;
    const closeProvider = vi.fn(async () => closeGate);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    const closing = releaser.closeIfIdle();
    await vi.waitFor(() => expect(closeProvider).toHaveBeenCalled());
    const activity = releaser.runActivity("openai", async () => {
      activityStarted = true;
    });
    await Promise.resolve();
    expect(activityStarted).toBe(false);

    finishClose();
    await Promise.all([closing, activity]);
    expect(activityStarted).toBe(true);
    await releaser.stop();
  });

  it("does not start another close while a close is in flight", async () => {
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const closeProvider = vi.fn(async () => closeGate);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    const first = releaser.closeIfIdle();
    await vi.waitFor(() => expect(closeProvider).toHaveBeenCalledTimes(1));
    const second = releaser.closeIfIdle();
    expect(closeProvider).toHaveBeenCalledTimes(1);

    finishClose();
    await Promise.all([first, second]);
    await releaser.stop();
  });

  it("retries a failed Client close on the next lifecycle check", async () => {
    const closeProvider = vi.fn()
      .mockRejectedValueOnce(new Error("temporary close failure"))
      .mockResolvedValueOnce(undefined);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => [],
      gracePeriodMs: 0,
    });

    await releaser.closeIfIdle();
    await releaser.closeIfIdle();

    expect(closeProvider).toHaveBeenCalledTimes(2);
    await releaser.stop();
  });

  it("waits for the grace window and notifies before closing Clients", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai", "deepseek"],
      closeProvider: async (provider) => {
        events.push(`close:${provider}`);
      },
      listBindings: () => [],
      gracePeriodMs: 60_000,
      notifyBeforeClose: (providers) => {
        events.push(`notify:${providers.join(",")}`);
      },
    });
    try {
      const closing = releaser.closeIfIdle(true);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(events).toEqual([
        "notify:openai,deepseek",
        "close:openai",
        "close:deepseek",
      ]);
    } finally {
      await releaser.stop();
      vi.useRealTimers();
    }
  });

  it("does not notify for an ordinary global idle check", async () => {
    vi.useFakeTimers();
    const closeProvider = vi.fn(async () => undefined);
    const notifyBeforeClose = vi.fn();
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => [],
      gracePeriodMs: 60_000,
      notifyBeforeClose,
    });
    try {
      const closing = releaser.closeIfIdle();
      await vi.advanceTimersByTimeAsync(60_000);
      await closing;
      expect(notifyBeforeClose).not.toHaveBeenCalled();
      expect(closeProvider).toHaveBeenCalledWith("openai");
    } finally {
      await releaser.stop();
      vi.useRealTimers();
    }
  });

  it("upgrades an existing idle round when the automatic release arrives", async () => {
    vi.useFakeTimers();
    const notifyBeforeClose = vi.fn();
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider: async () => undefined,
      listBindings: () => [],
      gracePeriodMs: 60_000,
      notifyBeforeClose,
    });
    try {
      const closing = releaser.closeIfIdle();
      void releaser.closeIfIdle(true);
      await vi.advanceTimersByTimeAsync(60_000);
      await closing;
      expect(notifyBeforeClose).toHaveBeenCalledWith(["openai"]);
    } finally {
      await releaser.stop();
      vi.useRealTimers();
    }
  });

  it("cancels the grace window when a binding returns", async () => {
    vi.useFakeTimers();
    let bindings: Array<typeof binding> = [];
    const closeProvider = vi.fn(async () => undefined);
    const notifyBeforeClose = vi.fn();
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => bindings,
      gracePeriodMs: 60_000,
      notifyBeforeClose,
    });
    try {
      const closing = releaser.closeIfIdle();
      bindings = [binding];
      await vi.advanceTimersByTimeAsync(60_000);
      await closing;
      expect(closeProvider).not.toHaveBeenCalled();
      expect(notifyBeforeClose).not.toHaveBeenCalled();
    } finally {
      await releaser.stop();
      vi.useRealTimers();
    }
  });

  it("cancels the grace window when a new Provider operation starts", async () => {
    vi.useFakeTimers();
    let started = false;
    const closeProvider = vi.fn(async () => undefined);
    const notifyBeforeClose = vi.fn();
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider,
      listBindings: () => [],
      gracePeriodMs: 60_000,
      notifyBeforeClose,
    });
    try {
      const closing = releaser.closeIfIdle();
      const activity = releaser.runActivity("openai", async () => {
        started = true;
      });
      await activity;
      expect(started).toBe(true);
      expect(closeProvider).not.toHaveBeenCalled();
      expect(notifyBeforeClose).not.toHaveBeenCalled();
      await releaser.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});

function silentLogger(): import("pino").Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import("pino").Logger;
}
