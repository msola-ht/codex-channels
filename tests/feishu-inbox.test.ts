import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonRpcError } from "../src/codex-client/index.js";
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

  it("delivers /stop without waiting for an earlier message in the same Chat", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const urgent: FeishuInboxMessage[] = [];
    const fixture = createFixture({
      handle: async (message) => {
        fixture.handled.push(message);
        await firstPending;
      },
      handleUrgent: async (message) => {
        urgent.push(message);
      },
    });

    expect(fixture.inbox.receive(createEvent())).toEqual({ status: "accepted" });
    await settle();
    expect(fixture.handled).toHaveLength(1);

    expect(fixture.inbox.receive(createEvent({
      eventId: "event-stop",
      messageId: "om_stop",
      content: JSON.stringify({ text: "/stop" }),
    }))).toEqual({ status: "accepted" });
    await settle();

    expect(urgent).toEqual([
      expect.objectContaining({ kind: "text", text: "/stop" }),
    ]);

    releaseFirst();
    await fixture.inbox.close();
  });

  it("preserves the validated Feishu reply parent identifier", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      parentId: "om_parent",
    }))).toEqual({ status: "accepted" });
    await fixture.inbox.close();

    expect(fixture.handled).toEqual([
      expect.objectContaining({ parentId: "om_parent" }),
    ]);
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
        imageKeys: ["img_v2_resource"],
      }),
    ]);
  });

  it("accepts one private file reference without downloading in the SDK callback", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "file",
      content: JSON.stringify({
        file_key: "file_v2_resource",
        file_name: "settings.json",
      }),
    }))).toEqual({
      status: "accepted",
    });
    expect(fixture.handled).toHaveLength(0);

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "file",
        fileKey: "file_v2_resource",
        fileName: "settings.json",
      }),
    ]);
  });

  it("accepts one private audio reference without downloading in the SDK callback", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "audio",
      content: JSON.stringify({
        file_key: "file_v2_audio",
        duration: 12_000,
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "audio",
        fileKey: "file_v2_audio",
        durationMs: 12_000,
      }),
    ]);
  });

  it("collects adjacent image events into one ordered image batch", async () => {
    vi.useFakeTimers();
    const batches: FeishuInboxMessage[][] = [];
    const fixture = createFixture({
      inputQuietWindowMs: 1_000,
      handleImageBatch: async (messages) => {
        batches.push([...messages]);
      },
    });

    expect(fixture.inbox.receive(createEvent({
      eventId: "event-image-1",
      messageId: "om_image_1",
      messageType: "image",
      content: "{\"image_key\":\"img_v2_first\"}",
    }))).toEqual({ status: "accepted" });
    expect(fixture.inbox.receive(createEvent({
      eventId: "event-image-2",
      messageId: "om_image_2",
      messageType: "image",
      content: "{\"image_key\":\"img_v2_second\"}",
    }))).toEqual({ status: "accepted" });

    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.inbox.close();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((item) => item.messageId)).toEqual([
      "om_image_1",
      "om_image_2",
    ]);
    expect(fixture.handled).toHaveLength(0);
  });

  it("accepts one private rich-post image with its text caption", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        title: "",
        content: [[
          { tag: "img", image_key: "img_v2_resource" },
          { tag: "text", text: "收得到吗" },
        ]],
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "image",
        imageKeys: ["img_v2_resource"],
        text: "收得到吗",
      }),
    ]);
  });

  it("accepts the official locale wrapper for an image caption", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "",
          content: [[
            { tag: "text", text: "请看截图" },
            { tag: "img", image_key: "img_v2_resource" },
          ]],
        },
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "image",
        imageKeys: ["img_v2_resource"],
        text: "请看截图",
      }),
    ]);
  });

  it("accepts a private rich-post text message with links", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "飞书菜单分析",
          content: [
            [
              { tag: "text", text: "官方文档：" },
              {
                tag: "a",
                href: "https://open.feishu.cn/document",
                text: "飞书开放平台",
              },
            ],
            [{ tag: "text", text: "请继续处理。" }],
          ],
        },
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "text",
        text: [
          "飞书菜单分析",
          "官方文档：飞书开放平台 (https://open.feishu.cn/document)",
          "请继续处理。",
        ].join("\n"),
      }),
    ]);
  });

  it("accepts a private rich-post code block message", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [[
            {
              tag: "code_block",
              language: "TYPESCRIPT",
              text: "const answer = 42;\nconsole.log(answer);",
            },
          ]],
        },
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "const answer = 42;\nconsole.log(answer);",
      }),
    ]);
  });

  it("accepts a private rich-post markdown message", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        content: [[
          {
            tag: "md",
            text: "```ts\nconst x = 1;\n```",
          },
        ]],
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "```ts\nconst x = 1;\n```",
      }),
    ]);
  });

  it("rejects rich-post messages with unsupported elements", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        content: [[
          { tag: "emotion", emoji_type: "SMILE" },
        ]],
      }),
    }))).toEqual({
      status: "ignored",
      reason: "invalid-content",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toHaveLength(0);
  });

  it("accepts multiple rich-post images with their shared caption", async () => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "post",
      content: JSON.stringify({
        content: [[
          { tag: "img", image_key: "img_v2_first" },
          { tag: "img", image_key: "img_v2_second" },
          { tag: "text", text: "飞书多图发送测试" },
        ]],
      }),
    }))).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toEqual([
      expect.objectContaining({
        kind: "image",
        imageKeys: ["img_v2_first", "img_v2_second"],
        text: "飞书多图发送测试",
      }),
    ]);
  });

  it.each([
    [{ appId: "cli_ffffffffffffffff" }, "account-mismatch"],
    [{ senderType: "bot" }, "non-user"],
    [{ chatType: "group" }, "unsupported-chat"],
    [{ messageType: "media" }, "unsupported-message"],
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

  it.each([
    "",
    "{}",
    "{\"file_key\":\"\",\"file_name\":\"notes.txt\"}",
    "{\"file_key\":\"../secret\",\"file_name\":\"notes.txt\"}",
    "{\"file_key\":\"file_v2_resource\",\"file_name\":\"../secret.txt\"}",
  ])("rejects invalid file content", async (content) => {
    const fixture = createFixture();

    expect(fixture.inbox.receive(createEvent({
      messageType: "file",
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

  it("does not let an unauthorized delivery consume the deduplication key", async () => {
    let allowed = false;
    const fixture = createFixture({
      access: {
        isAllowed: () => allowed,
      },
    });

    expect(fixture.inbox.receive(createEvent())).toEqual({
      status: "ignored",
      reason: "unauthorized",
    });
    allowed = true;
    expect(fixture.inbox.receive(createEvent())).toEqual({
      status: "accepted",
    });

    await fixture.inbox.close();
    expect(fixture.handled).toHaveLength(1);
    expect(fixture.remembered).toHaveLength(1);
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

  it("preserves sanitized JSON-RPC diagnostics without exposing messages", async () => {
    const fixture = createFixture({
      handle: async () => {
        throw new JsonRpcError(
          -32600,
          "no active turn to steer",
          { token: "secret" },
        );
      },
    });

    fixture.inbox.receive(createEvent({
      eventId: "event-rpc",
      messageId: "message-rpc",
      content: "{\"text\":\"image follow-up\"}",
    }));
    await fixture.inbox.close();

    expect(fixture.errors).toEqual([{
      target: {
        surface: "feishu",
        accountId: "cli_0123456789abcdef",
        conversationId: "oc_chat",
      },
      messageId: "message-rpc",
      errorType: "JsonRpcError",
      errorCode: -32600,
      errorReason: "no-active-turn",
    }]);
    expect(JSON.stringify(fixture.errors)).not.toContain("secret");
    expect(JSON.stringify(fixture.errors)).not.toContain("image follow-up");
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

  it("does not start queued messages after close times out", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      closeTimeoutMs: 250,
      handle: async (message) => {
        const text = textOf(message);
        calls.push(text);
        if (text === "first") {
          await gate;
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
    await vi.advanceTimersByTimeAsync(0);

    const closing = fixture.inbox.close();
    await vi.advanceTimersByTimeAsync(250);
    await closing;
    release();
    await settle();

    expect(calls).toEqual(["first"]);
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
