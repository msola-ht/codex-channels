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
      isAccountProvider: (provider) => provider.startsWith("opencode-go-"),
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
      isAccountProvider: (provider) => provider.startsWith("opencode-go-"),
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
      isAccountProvider: (provider) => provider.startsWith("opencode-go-"),
      listRunningProviders: async () => ["opencode-go-main"],
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
      providerForThread: () => "opencode-go-main",
      listBindings: () => [binding],
      defaultRoleProvider: () => undefined,
      notify: () => undefined,
      idleThresholdMs: 0,
      nowMs: () => 1_000,
    });

    await releaser.scan();

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
