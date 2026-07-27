import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../src/policy/index.js";
import {
  WeixinInputAdapter,
  WeixinInputFatalError,
  WeixinProtocolError,
  WeixinReplyContextStore,
  type WeixinProtocolClient,
  type WeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target: ConversationTarget = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
};

describe("WeixinInputAdapter", () => {
  it("authorizes, remembers the actor, submits text, and commits afterward", async () => {
    const events: string[] = [];
    const controller = clientFixture();
    const cursorStore = cursorStoreFixture((cursor) => {
      events.push(`cursor:${cursor}`);
    });
    const access = accessFixture(true, events);
    const actorRegistry = actorRegistryFixture(events);
    const replyContexts = new WeixinReplyContextStore(accountId);
    const service = serviceFixture(async () => {
      events.push("submit");
      return { threadId: "thread", turnId: "turn", steered: false };
    });
    const onFatal = vi.fn();
    const adapter = new WeixinInputAdapter({
      accountId,
      client: controller.client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access,
      replyContexts,
      actorRegistry,
      onFatal,
    });

    await adapter.start();
    controller.deliver("cursor-one");
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
    });
    await adapter.stop();

    expect(events).toEqual([
      "access",
      "actor",
      "submit",
      "cursor:cursor-one",
    ]);
    expect(service.submit).toHaveBeenCalledWith(target, "hello");
    expect(actorRegistry.rememberActor).toHaveBeenCalledWith(target, actorId);
    expect(replyContexts.get(target)).toEqual({
      actorId,
      contextToken: "context-secret",
    });
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("commits unauthorized messages without recording or submitting them", async () => {
    const controller = clientFixture();
    const cursorStore = cursorStoreFixture();
    const access = accessFixture(false);
    const actorRegistry = actorRegistryFixture();
    const service = serviceFixture();
    const replyContexts = new WeixinReplyContextStore(accountId);
    replyContexts.remember(target, actorId, "previous-context");
    const adapter = new WeixinInputAdapter({
      accountId,
      client: controller.client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access,
      replyContexts,
      actorRegistry,
      onFatal: vi.fn(),
    });

    await adapter.start();
    controller.deliver("cursor-one");
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
    });
    await adapter.stop();

    expect(access.isAllowed).toHaveBeenCalledWith({ target, actorId });
    expect(actorRegistry.rememberActor).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
    expect(replyContexts.get(target)).toBeUndefined();
  });

  it("reports a constrained fatal error and preserves the cursor on submission failure", async () => {
    const controller = clientFixture();
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture(async () => {
      throw new Error("private application detail");
    });
    const onFatal = vi.fn();
    const adapter = new WeixinInputAdapter({
      accountId,
      client: controller.client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    controller.deliver("cursor-one");
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledOnce();
    });
    await adapter.stop();

    const error = onFatal.mock.calls[0]?.[0] as WeixinInputFatalError;
    expect(error).toBeInstanceOf(WeixinInputFatalError);
    expect(error).toMatchObject({
      code: "message-processing",
      message: "微信消息接收已停止",
    });
    expect(error.message).not.toContain("private");
    expect(cursorStore.set).not.toHaveBeenCalled();
  });

  it("reports an unexpected protocol abort as fatal", async () => {
    const onFatal = vi.fn();
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async () => {
        throw new WeixinProtocolError("aborted", "unexpected abort");
      }),
      sendText: vi.fn(async () => {}),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({
        code: "aborted",
        message: "微信消息接收已停止",
      }));
    });
    await adapter.stop();
  });

  it("starts once and stops repeated calls without reporting cancellation as fatal", async () => {
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const onFatal = vi.fn();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    await adapter.start();
    await vi.waitFor(() => {
      expect(client.getUpdates).toHaveBeenCalledOnce();
    });

    const firstStop = adapter.stop();
    const secondStop = adapter.stop();
    expect(firstStop).toBe(secondStop);
    await firstStop;
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("bounds shutdown when an injected client ignores cancellation", async () => {
    const onStopTimeout = vi.fn();
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn<WeixinProtocolClient["getUpdates"]>(
        () => new Promise<never>(() => {}),
      ),
      sendText: vi.fn(async () => {}),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal: vi.fn(),
      onStopTimeout,
      closeTimeoutMs: 1,
    });

    await adapter.start();
    await adapter.stop();

    expect(onStopTimeout).toHaveBeenCalledOnce();
  });
});

function clientFixture(): {
  client: WeixinProtocolClient;
  deliver(cursor: string): void;
} {
  let deliver: ((cursor: string) => void) | undefined;
  let delivered = false;
  const client: WeixinProtocolClient = {
    getUpdates: vi.fn<WeixinProtocolClient["getUpdates"]>(
      async (_cursor, signal) => {
        if (!delivered) {
          const nextCursor = await new Promise<string>((resolve) => {
            deliver = resolve;
          });
          delivered = true;
          return {
            cursor: nextCursor,
            messages: [{
              kind: "text",
              messageId: "9007199254740993",
              actorId,
              conversationId: actorId,
              contextToken: "context-secret",
              text: "hello",
            }],
          };
        }
        return await waitForAbort(signal);
      },
    ),
    sendText: vi.fn(async () => {}),
  };
  return {
    client,
    deliver(cursor) {
      if (deliver === undefined) {
        throw new Error("client is not polling");
      }
      deliver(cursor);
    },
  };
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      reject(new WeixinProtocolError("aborted", "aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function cursorStoreFixture(
  onSet?: (cursor: string) => void,
): WeixinUpdatesCursorStore & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async (_accountId: string, cursor: string) => {
      onSet?.(cursor);
    }),
    remove: vi.fn(async () => {}),
  };
}

function accessFixture(
  allowed: boolean,
  events?: string[],
): SurfaceAccessPolicy & {
  isAllowed: ReturnType<typeof vi.fn>;
} {
  return {
    isAllowed: vi.fn(() => {
      events?.push("access");
      return allowed;
    }),
  };
}

function actorRegistryFixture(
  events?: string[],
): ConversationActorRegistry & {
  rememberActor: ReturnType<typeof vi.fn>;
} {
  return {
    actors: vi.fn(() => []),
    rememberActor: vi.fn(() => {
      events?.push("actor");
    }),
  };
}

function serviceFixture(
  implementation: (
    target: ConversationTarget,
    text: string,
  ) => ReturnType<ConversationService["submit"]> = async () => ({
    threadId: "thread",
    turnId: "turn",
    steered: false,
  }),
): ConversationService & {
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    submit: vi.fn(implementation),
  } as unknown as ConversationService & {
    submit: ReturnType<typeof vi.fn>;
  };
}

function outboxFixture() {
  return {
    notifyText: vi.fn(() => true),
  };
}
