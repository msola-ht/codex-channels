import { describe, expect, it, vi } from "vitest";

import {
  WeixinProtocolError,
  createWeixinUpdatesMonitor,
  type WeixinInboundMessage,
  type WeixinProtocolClient,
  type WeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";

describe("WeixinUpdatesMonitor", () => {
  it("reports each poll attempt and successful response for runtime health", async () => {
    const controller = new AbortController();
    const onPollStart = vi.fn();
    const onPollSuccess = vi.fn();
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client: clientFixture([
        { cursor: "cursor", messages: [] },
        () => {
          controller.abort();
          throw new WeixinProtocolError("aborted", "aborted");
        },
      ]),
      cursorStore: cursorStoreFixture("cursor"),
      handleMessage: async () => {},
      onPollStart,
      onPollSuccess,
    });

    await expect(monitor.run(controller.signal)).resolves.toBeUndefined();
    expect(onPollStart).toHaveBeenCalledTimes(2);
    expect(onPollSuccess).toHaveBeenCalledTimes(1);
    expect(onPollSuccess).toHaveBeenCalledWith(expect.any(Number));
  });

  it("commits an advanced cursor from an empty successful poll", async () => {
    const controller = new AbortController();
    const cursorStore = cursorStoreFixture("old-cursor");
    const handleMessage = vi.fn(async () => {});
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client: clientFixture([
        { cursor: "new-cursor", messages: [] },
        () => {
          controller.abort();
          throw new WeixinProtocolError("aborted", "aborted");
        },
      ]),
      cursorStore,
      handleMessage,
    });

    await expect(monitor.run(controller.signal)).resolves.toBeUndefined();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(cursorStore.set).toHaveBeenCalledOnce();
    expect(cursorStore.set).toHaveBeenCalledWith(accountId, "new-cursor");
  });

  it("delivers a batch in order and commits its cursor afterward", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const cursorStore = cursorStoreFixture(null, async (_account, cursor) => {
      events.push(`cursor:${cursor}`);
    });
    const client = clientFixture([
      {
        cursor: "cursor-one",
        messages: [
          textMessage("1", "first"),
          ignoredMessage("2"),
          textMessage("3", "third"),
        ],
      },
      () => {
        controller.abort();
        throw new WeixinProtocolError("aborted", "aborted");
      },
    ]);
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client,
      cursorStore,
      handleMessage: async (message) => {
        events.push(`message:${message.messageId}`);
      },
    });

    await expect(monitor.run(controller.signal)).resolves.toBeUndefined();

    expect(events).toEqual([
      "message:1",
      "message:3",
      "cursor:cursor-one",
    ]);
    expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
  });

  it("does not let a later text message overtake an earlier one", async () => {
    const controller = new AbortController();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const client = clientFixture([
      {
        cursor: "cursor-one",
        messages: [
          textMessage("1", "first"),
          textMessage("2", "/new"),
        ],
      },
      () => {
        controller.abort();
        throw new WeixinProtocolError("aborted", "aborted");
      },
    ]);
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client,
      cursorStore: cursorStoreFixture(null),
      handleMessage: async (message) => {
        events.push(`start:${message.messageId}`);
        if (message.messageId === "1") {
          await firstGate;
        }
        events.push(`end:${message.messageId}`);
      },
    });

    const running = monitor.run(controller.signal);
    await vi.waitFor(() => expect(events).toContain("start:1"));
    expect(events).toEqual(["start:1"]);
    releaseFirst();
    await running;

    expect(events).toEqual([
      "start:1",
      "end:1",
      "start:2",
      "end:2",
    ]);
  });

  it("does not commit a cursor when message handling fails", async () => {
    const cursorStore = cursorStoreFixture("old-cursor");
    const client = clientFixture([{
      cursor: "new-cursor",
      messages: [textMessage("1", "text")],
    }]);
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client,
      cursorStore,
      handleMessage: async () => {
        throw new Error("application unavailable");
      },
    });

    await expect(monitor.run(new AbortController().signal)).rejects.toThrow(
      "application unavailable",
    );
    expect(cursorStore.set).not.toHaveBeenCalled();
  });

  it("deduplicates raw message IDs before committing the batch", async () => {
    const controller = new AbortController();
    const cursorStore = cursorStoreFixture("old-cursor");
    const client = clientFixture([
      {
        cursor: "new-cursor",
        messages: [
          textMessage("9007199254740993", "first"),
          textMessage("9007199254740993", "duplicate"),
        ],
      },
      () => {
        controller.abort();
        throw new WeixinProtocolError("aborted", "aborted");
      },
    ]);
    const handleMessage = vi.fn<
      (
        message: Extract<WeixinInboundMessage, { kind: "text" }>,
      ) => Promise<void>
    >(async () => {});
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client,
      cursorStore,
      handleMessage,
    });

    await monitor.run(controller.signal);

    expect(handleMessage).toHaveBeenCalledOnce();
    expect(handleMessage.mock.calls[0]?.[0].text).toBe("first");
    expect(cursorStore.set).toHaveBeenCalledWith(accountId, "new-cursor");
  });

  it("backs off after constrained transient failures and resumes polling", async () => {
    const controller = new AbortController();
    const cursorStore = cursorStoreFixture("cursor");
    const client = clientFixture([
      () => {
        throw new WeixinProtocolError("network-error", "network");
      },
      () => {
        throw new WeixinProtocolError("http-error", "rate limit", 429);
      },
      () => {
        throw new WeixinProtocolError("http-error", "server", 503);
      },
      { cursor: "cursor", messages: [] },
      () => {
        controller.abort();
        throw new WeixinProtocolError("aborted", "aborted");
      },
    ]);
    const onRetry = vi.fn();
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client,
      cursorStore,
      handleMessage: async () => {},
      retryDelayMs: 0,
      backoffDelayMs: 0,
      onRetry,
    });

    await monitor.run(controller.signal);

    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      code: "network-error",
      delayMs: 0,
      phase: "retry",
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      code: "http-error",
      delayMs: 0,
      phase: "retry",
      status: 429,
    });
    expect(onRetry).toHaveBeenNthCalledWith(3, {
      attempt: 3,
      code: "http-error",
      delayMs: 0,
      phase: "backoff",
      status: 503,
    });
    expect(cursorStore.set).not.toHaveBeenCalled();
  });

  it("pauses a stale credential without stopping other Gateway surfaces", async () => {
    const controller = new AbortController();
    const onRetry = vi.fn();
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client: clientFixture([
        () => {
          throw new WeixinProtocolError(
            "api-error",
            "stale credential",
            undefined,
            -14,
          );
        },
        { cursor: "cursor", messages: [] },
        () => {
          controller.abort();
          throw new WeixinProtocolError("aborted", "aborted");
        },
      ]),
      cursorStore: cursorStoreFixture("cursor"),
      handleMessage: async () => {},
      staleCredentialPauseMs: 0,
      onRetry,
    });

    await expect(monitor.run(controller.signal)).resolves.toBeUndefined();
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      code: "api-error",
      delayMs: 0,
      phase: "credential-pause",
      returnCode: -14,
    });
  });

  it("does not retry unknown API errors or batches without a commit cursor", async () => {
    const apiClient = clientFixture([() => {
      throw new WeixinProtocolError(
        "api-error",
        "expired",
        undefined,
        -15,
      );
    }]);
    const apiRetry = vi.fn();
    const apiMonitor = createWeixinUpdatesMonitor({
      accountId,
      client: apiClient,
      cursorStore: cursorStoreFixture(null),
      handleMessage: async () => {},
      retryDelayMs: 0,
      onRetry: apiRetry,
    });
    await expect(apiMonitor.run(new AbortController().signal))
      .rejects.toMatchObject({ code: "api-error" });
    expect(apiRetry).not.toHaveBeenCalled();

    const handleMessage = vi.fn(async () => {});
    const cursorMonitor = createWeixinUpdatesMonitor({
      accountId,
      client: clientFixture([{
        cursor: "",
        messages: [textMessage("1", "text")],
      }]),
      cursorStore: cursorStoreFixture(null),
      handleMessage,
    });
    await expect(cursorMonitor.run(new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid-response" });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("treats long-poll timeouts as normal and exits on cancellation", async () => {
    const controller = new AbortController();
    const client = clientFixture([
      () => {
        throw new WeixinProtocolError("timeout", "timeout");
      },
      () => {
        controller.abort();
        throw new WeixinProtocolError("aborted", "aborted");
      },
    ]);
    const onRetry = vi.fn();
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client,
      cursorStore: cursorStoreFixture(null),
      handleMessage: async () => {},
      onRetry,
    });

    await expect(monitor.run(controller.signal)).resolves.toBeUndefined();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("fails closed on an unexpected client abort", async () => {
    const onRetry = vi.fn();
    const monitor = createWeixinUpdatesMonitor({
      accountId,
      client: clientFixture([() => {
        throw new WeixinProtocolError("aborted", "unexpected abort");
      }]),
      cursorStore: cursorStoreFixture(null),
      handleMessage: async () => {},
      onRetry,
    });

    await expect(monitor.run(new AbortController().signal))
      .rejects.toMatchObject({ code: "aborted" });
    expect(onRetry).not.toHaveBeenCalled();
  });
});

function textMessage(
  messageId: string,
  text: string,
): Extract<WeixinInboundMessage, { kind: "text" }> {
  return {
    kind: "text",
    messageId,
    actorId: "actor-fixture@im.wechat",
    conversationId: "actor-fixture@im.wechat",
    contextToken: "context-secret",
    text,
  };
}

function ignoredMessage(
  messageId: string,
): Extract<WeixinInboundMessage, { kind: "ignored" }> {
  return {
    kind: "ignored",
    messageId,
    reason: "unsupported-content",
  };
}

function cursorStoreFixture(
  initialCursor: string | null,
  setImplementation?: (
    accountId: string,
    cursor: string,
  ) => Promise<void>,
): WeixinUpdatesCursorStore & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => initialCursor),
    set: vi.fn(setImplementation ?? (async () => {})),
    remove: vi.fn(async () => {}),
  };
}

function clientFixture(
  responses: Array<
    | Awaited<ReturnType<WeixinProtocolClient["getUpdates"]>>
    | (() => never)
  >,
): WeixinProtocolClient {
  return {
    getUpdates: vi.fn(async () => {
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("unexpected getUpdates call");
      }
      return typeof next === "function" ? next() : next;
    }),
    sendText: vi.fn(async () => {}),
  };
}
