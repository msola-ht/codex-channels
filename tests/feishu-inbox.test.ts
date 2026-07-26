import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuInbox,
  type FeishuInboxMessage,
  type FeishuInboxOptions,
  type FeishuInboxProcessingError,
} from "../src/surfaces/feishu/inbox.js";
import type { FeishuMessageEvent } from "../src/surfaces/feishu/message-event.js";

const now = 1_784_900_000_000;

function createEvent(
  overrides: Partial<FeishuMessageEvent> = {},
): FeishuMessageEvent {
  return {
    eventId: "event-1",
    appId: "cli_0123456789abcdef",
    actorOpenId: "ou_actor",
    senderType: "user",
    messageId: "om_message",
    createTime: String(now),
    chatId: "oc_chat",
    chatType: "p2p",
    messageType: "text",
    content: "{\"text\":\"hello\"}",
    ...overrides,
  };
}

function createFixture(
  overrides: Partial<FeishuInboxOptions> = {},
) {
  const handled: FeishuInboxMessage[] = [];
  const remembered: Array<{
    target: FeishuInboxMessage["target"];
    actorId: string;
  }> = [];
  const errors: FeishuInboxProcessingError[] = [];
  const closeTimeouts: number[] = [];
  const access = {
    isAllowed: vi.fn(() => true),
  };
  const options: FeishuInboxOptions = {
    accountId: "cli_0123456789abcdef",
    access,
    actorRegistry: {
      actors: () => [],
      rememberActor: (target, actorId) => {
        remembered.push({ target, actorId });
      },
    },
    handle: async (message) => {
      handled.push(message);
    },
    handleError: (details) => {
      errors.push(details);
    },
    handleCloseTimeout: (pendingCount) => {
      closeTimeouts.push(pendingCount);
    },
    now: () => now,
    ...overrides,
  };
  return {
    inbox: new FeishuInbox(options),
    access,
    handled,
    remembered,
    errors,
    closeTimeouts,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FeishuInbox", () => {
  it("authorizes and accepts a private text message synchronously", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      handle: async (message) => {
        fixture.handled.push(message);
        await gate;
      },
    });

    expect(fixture.inbox.receive(createEvent())).toEqual({
      status: "accepted",
    });
    expect(fixture.access.isAllowed).toHaveBeenCalledWith({
      target: {
        surface: "feishu",
        accountId: "cli_0123456789abcdef",
        conversationId: "oc_chat",
      },
      actorId: "ou_actor",
    });
    expect(fixture.handled).toHaveLength(0);
    expect(fixture.remembered).toHaveLength(0);

    await settle();
    expect(fixture.handled).toHaveLength(1);
    expect(fixture.remembered).toEqual([{
      target: fixture.handled[0]?.target,
      actorId: "ou_actor",
    }]);

    release();
    await fixture.inbox.close();
    expect(fixture.handled[0]).toMatchObject({
      eventId: "event-1",
      messageId: "om_message",
      createdAtMs: now,
      kind: "text",
      text: "hello",
    });
  });

  it("accepts a private image key without downloading in the SDK callback", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "image",
      content: "{\"image_key\":\"img_v2_resource\"}",
    }))).toEqual({
      status: "accepted",
    });
    expect(fixture.handled).toHaveLength(0);

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "image",
        imageKey: "img_v2_resource",
      }),
    ]);
  });

  it.each([
    [{ appId: "cli_ffffffffffffffff" }, "account-mismatch"],
    [{ senderType: "bot" }, "non-user"],
    [{ chatType: "group" }, "unsupported-chat"],
    [{ messageType: "file" }, "unsupported-message"],
    [{ createTime: "not-a-timestamp" }, "invalid-timestamp"],
    [{ content: "not-json" }, "invalid-content"],
    [{ content: "{}" }, "invalid-content"],
    [{ content: "{\"text\":\"  \"}" }, "empty-text"],
    [{ createTime: String(now - 300_001) }, "stale"],
  ])("ignores unsupported or permanent invalid input", async (overrides, reason) => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent(overrides))).toEqual({
      status: "ignored",
      reason,
    });
    expect(fixture.handled).toHaveLength(0);
    await fixture.inbox.close();
  });

  it.each([
    "",
    "{}",
    "{\"image_key\":\"\"}",
    "{\"image_key\":\"../secret\"}",
  ])("rejects invalid image content", async (content) => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "image",
      content,
    }))).toEqual({
      status: "ignored",
      reason: "invalid-content",
    });
    await fixture.inbox.close();
  });

  it("checks authorization before accepting and recording an actor", async () => {
    const fixture = createFixture({
      access: {
        isAllowed: () => false,
      },
    });

    expect(fixture.inbox.receive(createEvent())).toEqual({
      status: "ignored",
      reason: "unauthorized",
    });
    expect(fixture.handled).toHaveLength(0);
    expect(fixture.remembered).toHaveLength(0);
    await fixture.inbox.close();
  });

  it("deduplicates an accepted event without blocking a full-queue retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      capacity: 1,
      handle: async (message) => {
        fixture.handled.push(message);
        await gate;
      },
    });

    expect(fixture.inbox.receive(createEvent())).toEqual({ status: "accepted" });
    expect(fixture.inbox.receive(createEvent())).toEqual({
      status: "ignored",
      reason: "duplicate",
    });
    expect(fixture.inbox.receive(createEvent({
      eventId: "event-2",
      messageId: "om_message_2",
    }))).toEqual({
      status: "retry",
      reason: "overloaded",
    });

    release();
    await settle();
    expect(fixture.inbox.receive(createEvent({
      eventId: "event-2",
      messageId: "om_message_2",
    }))).toEqual({ status: "accepted" });
    await fixture.inbox.close();
  });

  it("expires and bounds in-memory deduplication entries", async () => {
    let clock = now;
    const fixture = createFixture({
      deduplicationCapacity: 1,
      deduplicationTtlMs: 100,
      now: () => clock,
    });

    expect(fixture.inbox.receive(createEvent())).toEqual({ status: "accepted" });
    await settle();
    expect(fixture.inbox.receive(createEvent())).toEqual({
      status: "ignored",
      reason: "duplicate",
    });

    expect(fixture.inbox.receive(createEvent({
      eventId: "event-2",
      messageId: "message-2",
    }))).toEqual({ status: "accepted" });
    await settle();
    expect(fixture.inbox.receive(createEvent())).toEqual({ status: "accepted" });
    await settle();

    clock += 101;
    expect(fixture.inbox.receive(createEvent())).toEqual({ status: "accepted" });
    await fixture.inbox.close();
  });

  it("preserves one Chat order while allowing another Chat to progress", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fixture = createFixture({
      handle: async (message) => {
        const text = textOf(message);
        calls.push(`${message.target.conversationId}:${text}:start`);
        if (text === "first") {
          await firstGate;
        }
        calls.push(`${message.target.conversationId}:${text}:end`);
      },
    });

    fixture.inbox.receive(createEvent({
      eventId: "event-1",
      messageId: "message-1",
      content: "{\"text\":\"first\"}",
    }));
    fixture.inbox.receive(createEvent({
      eventId: "event-2",
      messageId: "message-2",
      content: "{\"text\":\"second\"}",
    }));
    fixture.inbox.receive(createEvent({
      eventId: "event-3",
      messageId: "message-3",
      chatId: "oc_other",
      content: "{\"text\":\"other\"}",
    }));
    await settle();

    expect(calls).toEqual([
      "oc_chat:first:start",
      "oc_other:other:start",
      "oc_other:other:end",
    ]);

    releaseFirst();
    await fixture.inbox.close();
    expect(calls).toEqual([
      "oc_chat:first:start",
      "oc_other:other:start",
      "oc_other:other:end",
      "oc_chat:first:end",
      "oc_chat:second:start",
      "oc_chat:second:end",
    ]);
  });

  it("reports sanitized processing failures and continues", async () => {
    const calls: string[] = [];
    const fixture = createFixture({
      handle: async (message) => {
        const text = textOf(message);
        calls.push(text);
        if (text === "first") {
          throw new Error("sensitive upstream response");
        }
      },
    });

    fixture.inbox.receive(createEvent({
      eventId: "event-1",
      messageId: "message-1",
      content: "{\"text\":\"first\"}",
    }));
    fixture.inbox.receive(createEvent({
      eventId: "event-2",
      messageId: "message-2",
      content: "{\"text\":\"second\"}",
    }));
    await fixture.inbox.close();

    expect(calls).toEqual(["first", "second"]);
    expect(fixture.errors).toEqual([{
      target: {
        surface: "feishu",
        accountId: "cli_0123456789abcdef",
        conversationId: "oc_chat",
      },
      messageId: "message-1",
      errorType: "Error",
    }]);
    expect(JSON.stringify(fixture.errors)).not.toContain("sensitive");
    expect(JSON.stringify(fixture.errors)).not.toContain("first");
  });

  it("isolates error-reporter failures from later messages", async () => {
    const calls: string[] = [];
    const fixture = createFixture({
      handle: async (message) => {
        const text = textOf(message);
        calls.push(text);
        if (text === "first") {
          throw new Error("expected");
        }
      },
      handleError: () => {
        throw new Error("logger failed");
      },
    });

    fixture.inbox.receive(createEvent({
      eventId: "event-1",
      messageId: "message-1",
      content: "{\"text\":\"first\"}",
    }));
    fixture.inbox.receive(createEvent({
      eventId: "event-2",
      messageId: "message-2",
      content: "{\"text\":\"second\"}",
    }));
    await fixture.inbox.close();

    expect(calls).toEqual(["first", "second"]);
  });

  it("drains accepted work and rejects input after close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      handle: async () => gate,
    });
    fixture.inbox.receive(createEvent());

    const firstClose = fixture.inbox.close();
    const secondClose = fixture.inbox.close();
    expect(firstClose).toBe(secondClose);
    expect(fixture.inbox.receive(createEvent({
      eventId: "event-2",
    }))).toEqual({
      status: "ignored",
      reason: "closed",
    });

    release();
    await firstClose;
  });

  it("reports a finite close timeout without exposing message content", async () => {
    vi.useFakeTimers();
    const fixture = createFixture({
      closeTimeoutMs: 250,
      handle: async () => new Promise<void>(() => {}),
    });
    fixture.inbox.receive(createEvent());
    await vi.advanceTimersByTimeAsync(0);

    const closing = fixture.inbox.close();
    await vi.advanceTimersByTimeAsync(250);
    await closing;

    expect(fixture.closeTimeouts).toEqual([1]);
  });

  it("validates queue lifecycle limits", () => {
    expect(() => createFixture({ capacity: 0 })).toThrow(
      "飞书 Inbox 容量必须是正整数",
    );
    expect(() => createFixture({ closeTimeoutMs: 1.5 })).toThrow(
      "飞书 Inbox 关闭超时必须是正整数",
    );
    expect(() => createFixture({ deduplicationCapacity: 0 })).toThrow(
      "飞书 Inbox 去重容量必须是正整数",
    );
  });
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function textOf(message: FeishuInboxMessage): string {
  if (message.kind !== "text") {
    throw new Error("expected text message");
  }
  return message.text;
}
