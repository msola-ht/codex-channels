import { describe, expect, it, vi } from "vitest";

import { ConversationIdleReleaser, type ConversationIdleReleaserOptions } from "../src/bootstrap/conversation-idle-releaser.js";
import type { ConversationIdleReleaseCondition } from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { SessionRouter, type ThreadLifecyclePort, type ThreadSnapshot } from "../src/session-routing/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";
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
  it("restores another Provider's subscription while skipping the disconnected Provider's queued candidate", async () => {
    const store = new MemoryBindingStore();
    const other = { ...binding, target: { ...target, conversationId: "other" }, threadId: "other-thread", sessionId: "other-session" };
    store.bind(binding);
    store.bind(other);
    store.touchActivity(target, 1);
    store.touchActivity(other.target, 1);
    let finish!: () => void;
    let subscribed = true;
    const snapshot: ThreadSnapshot = {
      id: binding.threadId, sessionId: binding.sessionId, modelProvider: "openai", preview: "",
      isPinned: false, status: { type: "idle" }, cwd: "/workspace", source: "cli",
      name: null, activeTurnId: null, historyMode: "paginated",
    };
    const unsubscribeThread = vi.fn(async () => {
      subscribed = false;
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const resumeThread = vi.fn(async () => {
      subscribed = true;
      return {
        thread: snapshot, settingsMatch: true, collaborationMode: "default", model: "fixture",
        reasoningEffort: "medium", serviceTier: "default", contextCompactionItemIds: [],
        effectiveSettings: { cwd: "/workspace", approvalPolicy: "on-request", sandbox: "read-only", permissions: null },
      };
    });
    const router = new SessionRouter({ unsubscribeThread, resumeThread } as unknown as ThreadLifecyclePort,
      store, new WorkspaceRegistry([{ id: "main", name: "Main", cwd: "/workspace" }], "main"));
    const restored = vi.fn();
    const releaseIdle = vi.fn<ConversationIdleReleaserOptions["releaseIdle"]>(async (candidate, condition) => {
      await router.releaseIdle(candidate, binding, snapshot, {
        isCurrent: condition.isCurrent, canRestore: condition.canRestore,
        verifyIdle: async () => true, restored,
      });
      return { status: "busy", threadId: binding.threadId };
    });
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never, idleThresholdMs: 10, nowMs: () => 100,
      listForegroundBindings: () => [binding, other], idleState: candidate => router.idleState(candidate),
      ensureIdleState: vi.fn(), releaseIdle, notifyReleased: vi.fn(),
    });
    const scanning = releaser.scan();
    await vi.waitFor(() => expect(unsubscribeThread).toHaveBeenCalledOnce());
    router.touchActivity(target, 2);
    releaser.cancelPending(new Set([other.threadId]));
    finish();
    await scanning;
    expect(releaseIdle).toHaveBeenCalledOnce();
    expect(resumeThread).toHaveBeenCalledOnce();
    expect(restored).toHaveBeenCalledOnce();
    expect(subscribed).toBe(true);
    expect(store.get(target)).toEqual(binding);
    expect(store.idleState(target).forceNew).toBe(false);
    await releaser.stop();
  });

  it("continues scanning other Providers after cancelling the current Provider", async () => {
    const other = { ...binding, target: { ...target, conversationId: "other" }, threadId: "other-thread" };
    let finish!: () => void;
    const notifyReleased = vi.fn();
    const releaseIdle = vi.fn<ConversationIdleReleaserOptions["releaseIdle"]>(async (_target, condition) => {
      if (condition.threadId === binding.threadId) await new Promise<void>(resolve => { finish = resolve; });
      return { status: "released", threadId: condition.threadId };
    });
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never, idleThresholdMs: 10, nowMs: () => 100,
      listForegroundBindings: () => [binding, other], idleState: () => ({ lastActivityAt: 1, forceNew: false }),
      ensureIdleState: vi.fn(), releaseIdle, notifyReleased,
    });
    const scanning = releaser.scan();
    releaser.cancelPending(new Set([binding.threadId]));
    expect(releaseIdle.mock.calls[0]?.[1].signal.aborted).toBe(true);
    finish();
    await scanning;
    expect(releaseIdle).toHaveBeenCalledTimes(2);
    expect(releaseIdle.mock.calls[1]?.[1].signal.aborted).toBe(false);
    expect(notifyReleased).toHaveBeenCalledExactlyOnceWith(other.target, other.threadId);
    await releaser.stop();
  });

  it.each(["activity", "restore", "disconnect"])("invalidates an in-flight scan on %s", async change => {
    let at = 1;
    let restoring = false;
    let finish!: () => void;
    let condition!: ConversationIdleReleaseCondition;
    const notifyReleased = vi.fn();
    const releaseIdle = vi.fn(async (_target: ConversationTarget, candidate: ConversationIdleReleaseCondition) => {
      condition = candidate;
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "busy" as const, threadId: binding.threadId };
    });
    const releaser = new ConversationIdleReleaser({
      logger: { warn: vi.fn(), info: vi.fn() } as never, idleThresholdMs: 10,
      nowMs: () => 100, listForegroundBindings: () => [binding],
      idleState: () => ({ lastActivityAt: at, forceNew: false }),
      ensureIdleState: vi.fn(), isBindingRestoring: () => restoring,
      releaseIdle, notifyReleased,
    });
    const scan = releaser.scan();
    expect(condition?.isCurrent()).toBe(true);
    if (change === "activity") at = 2;
    if (change === "restore") restoring = true;
    if (change === "disconnect") releaser.cancelPending();
    expect(condition?.isCurrent()).toBe(false);
    finish();
    await scan;
    expect(notifyReleased).not.toHaveBeenCalled();
  });

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

    expect(releaseIdle).toHaveBeenCalledWith(target, expect.objectContaining({
      threadId: binding.threadId,
      lastActivityAt: now - 16 * 60_000,
      signal: expect.any(AbortSignal),
    }));
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

    expect(releaseIdle).toHaveBeenCalledWith(target, expect.objectContaining({ threadId: binding.threadId }));

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
    const releaseIdle = vi.fn<ConversationIdleReleaserOptions["releaseIdle"]>(
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
    expect(releaseIdle.mock.calls[0]?.[1].signal.aborted).toBe(true);
    resolveRelease?.();
    await scan;
  });
});
