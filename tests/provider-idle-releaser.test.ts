import { describe, expect, it, vi } from "vitest";

import { ProviderIdleReleaser } from "../src/bootstrap/provider-idle-releaser.js";

const binding = {
  target: { surface: "telegram", accountId: "account", conversationId: "bound" },
  workspaceId: "workspace",
  threadId: "thread",
  sessionId: "session",
};

describe("ProviderIdleReleaser", () => {
  it("closes every connected Provider Client when the Gateway has no bindings", async () => {
    const closed: string[] = [];
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai", "deepseek"],
      closeProvider: async (provider) => {
        closed.push(provider);
      },
      listBindings: () => [],
    });

    await releaser.closeIfIdle();

    expect(closed).toEqual(["openai", "deepseek"]);
  });

  it("keeps all Provider Clients running while any foreground or background binding exists", async () => {
    const closeProvider = vi.fn(async () => undefined);
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai", "deepseek"],
      closeProvider,
      listBindings: () => [binding],
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
    });

    const activity = releaser.runActivity("openai", () => activityGate);
    await releaser.closeIfIdle();
    expect(closeProvider).not.toHaveBeenCalled();

    finishActivity();
    await activity;
    await releaser.closeIfIdle();
    expect(closeProvider).toHaveBeenCalledWith("openai");
  });

  it("queues new Provider activity until a global Client close finishes", async () => {
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    let activityStarted = false;
    const releaser = new ProviderIdleReleaser({
      logger: silentLogger(),
      listConnectedProviders: () => ["openai"],
      closeProvider: async () => closeGate,
      listBindings: () => [],
    });

    const closing = releaser.closeIfIdle();
    const activity = releaser.runActivity("openai", async () => {
      activityStarted = true;
    });
    await Promise.resolve();
    expect(activityStarted).toBe(false);

    finishClose();
    await Promise.all([closing, activity]);
    expect(activityStarted).toBe(true);
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
    });

    const first = releaser.closeIfIdle();
    const second = releaser.closeIfIdle();
    expect(closeProvider).toHaveBeenCalledTimes(1);

    finishClose();
    await Promise.all([first, second]);
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
    });

    await releaser.closeIfIdle();
    await releaser.closeIfIdle();

    expect(closeProvider).toHaveBeenCalledTimes(2);
  });
});

function silentLogger(): import("pino").Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import("pino").Logger;
}
