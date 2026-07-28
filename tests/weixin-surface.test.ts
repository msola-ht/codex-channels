import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import type {
  OutputEvent,
} from "../src/conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../src/policy/index.js";
import type { SurfaceAdapter } from "../src/surfaces/index.js";
import {
  WeixinConfigurationDeliveryError,
  WeixinProtocolError,
  WeixinSurface,
  type WeixinProtocolClient,
  type WeixinReplyContextPersistence,
  type WeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
} as const;

describe("WeixinSurface", () => {
  it("forms an authorized inbound-to-final-output text loop", async () => {
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const actorRegistry = actorRegistryFixture();
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    let pollCount = 0;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch();
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const onFatal = vi.fn();
    const replyContextPersistence = replyContextPersistenceFixture();
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore,
      service,
      access: accessFixture(true),
      actorRegistry,
      replyContextPersistence,
      logger: pino({ level: "silent" }),
      onFatal,
    });
    const adapter: SurfaceAdapter = surface;

    expect(adapter.surface).toBe("weixin");
    expect(adapter.accountId).toBe(accountId);
    await surface.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
    });

    surface.output.handle(finalText("final reply"));
    surface.output.handle(turnCompleted());
    await surface.stop();

    expect(service.submit).toHaveBeenCalledWith(target, "hello");
    expect(actorRegistry.rememberActor).toHaveBeenCalledWith(target, actorId);
    expect(replyContextPersistence.set).toHaveBeenCalledWith(
      target,
      actorId,
      "context-secret",
    );
    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "final reply",
      "本次运行 · 已完成",
    ]);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("restores an encrypted reply context and sends the startup notification", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "Codex Connect 已上线\nApp Server：已连接",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(replyContextPersistence.get).toHaveBeenCalledWith(target);
    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "restored-context",
      text: "Codex Connect 已上线\n\nApp Server：已连接",
    });
  });

  it("removes a restored context instead of notifying a revoked actor", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText,
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(false),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "Codex Connect 已上线",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(replyContextPersistence.remove).toHaveBeenCalledWith(target);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("routes an inbound basic command through the shared service and reply context", async () => {
    const cursorStore = cursorStoreFixture();
    const submit = vi.fn();
    const stop = vi.fn(async () => true);
    const service = {
      submit,
      stop,
    } as unknown as ConversationService;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    let pollCount = 0;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch("/stop");
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore,
      service,
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
      expect(sendText).toHaveBeenCalledOnce();
    });
    await surface.stop();

    expect(submit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(target);
    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: "已请求停止当前任务。",
    });
  });

  it("stops input before draining output and keeps repeated lifecycle calls safe", async () => {
    const events: string[] = [];
    const cursorStore = cursorStoreFixture();
    let pollCount = 0;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(
      async () => {
        events.push("output:start");
        await outputGate.promise;
        events.push("output:end");
      },
    );
    let releaseOutput!: () => void;
    const outputGate = {
      promise: new Promise<void>((resolve) => {
        releaseOutput = resolve;
      }),
    };
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch();
        }
        return await waitForAbort(signal, () => {
          events.push("input:stopped");
        });
      }),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore,
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalled();
    });
    surface.output.handle(finalText("reply"));
    await vi.waitFor(() => {
      expect(events).toContain("output:start");
    });

    const firstStop = surface.stop();
    const secondStop = surface.stop();
    expect(firstStop).toBe(secondStop);
    await vi.waitFor(() => {
      expect(events).toContain("input:stopped");
    });
    expect(events).not.toContain("output:end");

    releaseOutput();
    await firstStop;
    expect(events.indexOf("input:stopped")).toBeLessThan(
      events.indexOf("output:end"),
    );
    expect(surface.output.notifyText(target, "late")).toBe(false);
  });

  it("reports receiver failure through the constrained fatal callback", async () => {
    const onFatal = vi.fn();
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -15,
          );
        }),
        sendText: vi.fn(async () => {}),
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal,
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({
        code: "api-error",
        message: "微信消息接收已停止",
      }));
    });
    expect(
      (onFatal.mock.calls[0]?.[0] as Error).message,
    ).not.toContain("private");
    await surface.stop();
  });

  it("logs a stale credential pause without stopping the Gateway", async () => {
    const onFatal = vi.fn();
    const warn = vi.fn();
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -14,
          );
        }),
        sendText: vi.fn(async () => {}),
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: { warn } as unknown as pino.Logger,
      onFatal,
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        {
          surface: "weixin",
          accountId,
          attempt: 1,
          code: "api-error",
          delayMs: 3_600_000,
          phase: "credential-pause",
          returnCode: -14,
        },
        "微信 Bot Token 已失效，已暂停轮询；请重新运行 codexc setup",
      );
    });
    expect(onFatal).not.toHaveBeenCalled();
    await surface.stop();
  });

  it("fails proactive configuration delivery closed without a reply context", async () => {
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await expect(surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [],
      addedWorkspaces: [],
    })).rejects.toBeInstanceOf(WeixinConfigurationDeliveryError);
    expect(client.sendText).not.toHaveBeenCalled();
    await surface.stop();
  });

  it("cannot restart after an idempotent stop-before-start", async () => {
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.stop();
    await expect(surface.stop()).resolves.toBeUndefined();
    await expect(surface.start()).rejects.toThrow(
      "微信输入 Adapter 已停止",
    );
    expect(client.getUpdates).not.toHaveBeenCalled();
  });

  it("starts the image store before input and closes it with the Surface", async () => {
    const images = {
      start: vi.fn(async () => {}),
      close: vi.fn(),
      download: vi.fn(),
    };
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      images,
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(images.start).toHaveBeenCalledOnce();
    expect(images.close).toHaveBeenCalledOnce();
  });
});

function inboundBatch(text = "hello") {
  return {
    cursor: "cursor-one",
    messages: [{
      kind: "text" as const,
      messageId: "9007199254740993",
      actorId,
      conversationId: actorId,
      contextToken: "context-secret",
      text,
    }],
  };
}

function finalText(
  text: string,
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    phase: "final_answer",
    text,
  };
}

function turnCompleted(): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    status: "completed",
  };
}

function waitForAbort(
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(new WeixinProtocolError("aborted", "aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function cursorStoreFixture(): WeixinUpdatesCursorStore & {
  set: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

function serviceFixture(): ConversationService & {
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    submit: vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    })),
  } as unknown as ConversationService & {
    submit: ReturnType<typeof vi.fn>;
  };
}

function actorRegistryFixture(): ConversationActorRegistry & {
  rememberActor: ReturnType<typeof vi.fn>;
} {
  return {
    actors: vi.fn(() => []),
    rememberActor: vi.fn<ConversationActorRegistry["rememberActor"]>(),
  };
}

function accessFixture(allowed: boolean): SurfaceAccessPolicy {
  return {
    isAllowed: vi.fn(() => allowed),
  };
}

function replyContextPersistenceFixture(
  restored: Awaited<
    ReturnType<WeixinReplyContextPersistence["get"]>
  > = null,
): WeixinReplyContextPersistence & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => restored),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
