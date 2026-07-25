import pino from "pino";
import { describe, expect, it } from "vitest";

import type {
  ConversationTarget,
  OutputEvent,
} from "../src/conversation-core/index.js";
import {
  FeishuOutbox,
  type FeishuTextMessagePort,
} from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu",
  accountId: "cli_app",
  conversationId: "oc_chat",
} as const;

describe("Feishu outbox", () => {
  it("routes a rendered event to the exact account and chat", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const messagePort: FeishuTextMessagePort = {
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    };
    const outbox = new FeishuOutbox(
      "cli_app",
      messagePort,
      pino({ level: "silent" }),
    );
    const event: OutputEvent = {
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "飞书回复",
    };

    outbox.handle(event);
    await outbox.close();

    expect(sent).toEqual([{ chatId: "oc_chat", text: "飞书回复" }]);
  });

  it("ignores another surface, account, and non-critical progress", async () => {
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        sendText: async (_chatId, text) => {
          sent.push(text);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({ surface: "telegram" }));
    outbox.handle(completed({ accountId: "another_app" }));
    outbox.handle({
      type: "text.delta",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "处理中",
    });
    await outbox.close();

    expect(sent).toEqual([]);
  });

  it("keeps one chat ordered while different chats can send concurrently", async () => {
    const first = deferred();
    const started: string[] = [];
    const finished: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        sendText: async (chatId, text) => {
          started.push(`${chatId}:${text}`);
          if (text === "第一条") {
            await first.promise;
          }
          finished.push(`${chatId}:${text}`);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, "第一条"));
    outbox.handle(completed({}, "第二条"));
    outbox.handle(completed({ conversationId: "oc_other" }, "其他会话"));
    await settle();

    expect(started).toEqual([
      "oc_chat:第一条",
      "oc_other:其他会话",
    ]);
    expect(finished).toEqual(["oc_other:其他会话"]);

    first.resolve();
    await outbox.close();

    expect(started).toEqual([
      "oc_chat:第一条",
      "oc_other:其他会话",
      "oc_chat:第二条",
    ]);
    expect(finished).toEqual([
      "oc_other:其他会话",
      "oc_chat:第一条",
      "oc_chat:第二条",
    ]);
  });

  it("splits a long plain-text result into ordered UTF-8-safe messages", async () => {
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        sendText: async (_chatId, text) => {
          sent.push(text);
        },
      },
      pino({ level: "silent" }),
    );
    const original = `${"中".repeat(7_000)}\n${"x".repeat(25_000)}😀`;

    expect(outbox.notifyText("oc_chat", original)).toBe(true);
    expect(outbox.notifyText("oc_chat", "分片之后")).toBe(true);
    await outbox.close();

    const chunks = sent.slice(0, -1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((text) => Buffer.byteLength(text, "utf8") <= 20_000))
      .toBe(true);
    expect(chunks.map((text, index) => {
      expect(text).toMatch(
        new RegExp(`^（${index + 1}/${chunks.length}）\\n`, "u"),
      );
      return text.replace(/^（\d+\/\d+）\n/u, "");
    }).join("")).toBe(original);
    expect(sent.at(-1)).toBe("分片之后");
  });

  it("bounds one logical output and marks oversized text as truncated", async () => {
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        sendText: async (_chatId, text) => {
          sent.push(text);
        },
      },
      pino({ level: "silent" }),
    );

    expect(outbox.notifyText("oc_chat", "中".repeat(100_000))).toBe(true);
    expect(outbox.notifyText("oc_chat", "截断之后")).toBe(true);
    await outbox.close();

    expect(sent).toHaveLength(6);
    expect(sent.slice(0, 5).every(
      (text) => Buffer.byteLength(text, "utf8") <= 20_000,
    )).toBe(true);
    expect(sent[4]).toContain("内容过长，已截断");
    expect(sent[5]).toBe("截断之后");
  });

  it("waits for accepted output during close and rejects later events", async () => {
    const pending = deferred();
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        sendText: async (_chatId, text) => {
          await pending.promise;
          sent.push(text);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, "关闭前"));
    const close = outbox.close();
    outbox.handle(completed({}, "关闭后"));
    await settle();
    expect(sent).toEqual([]);

    pending.resolve();
    await close;

    expect(sent).toEqual(["关闭前"]);
  });
});

function completed(
  targetOverrides: Partial<ConversationTarget> = {},
  text = "飞书回复",
): OutputEvent {
  return {
    type: "text.completed",
    target: { ...target, ...targetOverrides },
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: text,
    text,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
