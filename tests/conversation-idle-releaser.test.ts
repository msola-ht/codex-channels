import { describe, expect, it, vi } from "vitest";

import { ConversationIdleReleaser } from "../src/bootstrap/conversation-idle-releaser.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import type {
  ConversationBinding,
  ConversationIdleState,
} from "../src/storage/index.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "chat-idle",
};

const binding: ConversationBinding = {
  target,
  workspaceId: "main",
  threadId: "thread-idle",
  sessionId: "session-idle",
};

describe("ConversationIdleReleaser", () => {
  it("releases a foreground binding after the idle threshold and notifies once", async () => {
    const now = 1_000_000;
    const states = new Map<string, ConversationIdleState>([
      ["telegram:default:chat-idle", {
        lastActivityAt: now - 16 * 60_000,
        forceNew: false,
      }],
    ]);
    const releaseIdle = vi.fn(async () => ({
      status: "released" as const,
      threadId: binding.threadId,
    }));
    const notifyReleased = vi.fn();
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      idleThresholdMs: 15 * 60_000,
      nowMs: () => now,
      listForegroundBindings: () => [binding],
      idleState: (candidate) =>
        states.get(`${candidate.surface}:${candidate.accountId}:${candidate.conversationId}`)
          ?? { lastActivityAt: 0, forceNew: false },
      ensureIdleState: (candidate, atMs) =>
        states.set(`${candidate.surface}:${candidate.accountId}:${candidate.conversationId}`, {
          lastActivityAt: atMs,
          forceNew: false,
        }),
      releaseIdle,
      notifyReleased,
    });

    await releaser.scan();

    expect(releaseIdle).toHaveBeenCalledWith(target);
    expect(notifyReleased).toHaveBeenCalledWith(target, binding.threadId);
  });

  it("keeps the binding when the release path reports busy and skips force-new state", async () => {
    const states = new Map<string, ConversationIdleState>([
      ["telegram:default:chat-idle", {
        lastActivityAt: 1,
        forceNew: false,
      }],
    ]);
    const releaseIdle = vi.fn(async () => ({
      status: "busy" as const,
      threadId: binding.threadId,
    }));
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      idleThresholdMs: 15 * 60_000,
      nowMs: () => 20 * 60_000,
      listForegroundBindings: () => [binding],
      idleState: (candidate) =>
        states.get(`${candidate.surface}:${candidate.accountId}:${candidate.conversationId}`)
          ?? { lastActivityAt: 0, forceNew: false },
      ensureIdleState: () => undefined,
      releaseIdle,
      notifyReleased: vi.fn(),
    });

    await releaser.scan();

    expect(releaseIdle).toHaveBeenCalledWith(target);

    states.set("telegram:default:chat-idle", {
      lastActivityAt: 1,
      forceNew: true,
    });
    await releaser.scan();
    expect(releaseIdle).toHaveBeenCalledTimes(1);
  });

  it("does not scan or release when the threshold is disabled", async () => {
    const releaseIdle = vi.fn();
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      idleThresholdMs: 0,
      nowMs: () => 20 * 60_000,
      listForegroundBindings: () => [binding],
      idleState: () => ({
        lastActivityAt: 1,
        forceNew: false,
      }),
      ensureIdleState: () => undefined,
      releaseIdle,
      notifyReleased: vi.fn(),
    });

    await releaser.scan();

    expect(releaseIdle).not.toHaveBeenCalled();
  });

  it("skips a binding that is still being restored", async () => {
    const releaseIdle = vi.fn();
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      idleThresholdMs: 15 * 60_000,
      nowMs: () => 20 * 60_000,
      isBindingRestoring: () => true,
      listForegroundBindings: () => [binding],
      idleState: () => ({
        lastActivityAt: 1,
        forceNew: false,
      }),
      ensureIdleState: () => undefined,
      releaseIdle,
      notifyReleased: vi.fn(),
    });

    await releaser.scan();

    expect(releaseIdle).not.toHaveBeenCalled();
  });

  it("bounds shutdown while a release is still in flight", async () => {
    let resolveRelease: (() => void) | undefined;
    const releaseIdle = vi.fn(
      () => new Promise<{ status: "released"; threadId: string }>((resolve) => {
        resolveRelease = () => resolve({
          status: "released",
          threadId: binding.threadId,
        });
      }),
    );
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never,
      idleThresholdMs: 15 * 60_000,
      stopTimeoutMs: 20,
      nowMs: () => 20 * 60_000,
      listForegroundBindings: () => [binding],
      idleState: () => ({
        lastActivityAt: 1,
        forceNew: false,
      }),
      ensureIdleState: () => undefined,
      releaseIdle,
      notifyReleased: vi.fn(),
    });

    const scan = releaser.scan();
    await vi.waitFor(() => expect(releaseIdle).toHaveBeenCalled());
    await expect(releaser.stop()).resolves.toBeUndefined();
    resolveRelease?.();
    await scan;
  });
});
