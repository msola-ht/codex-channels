import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuMessageError, FeishuOutbox, type FeishuMessagePort } from "../src/surfaces/feishu/index.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { completed, target, turnCompleted } from "./support/feishu-outbox-fixtures.js";

function deferred(): { promise: Promise<void>; resolve(): void } { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function settle(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }


export const turnCompletedMarkdown = "## 本次运行 · 已完成\n\n- Session：测试会话\n- Session ID：thread-1";

const cardMethods = {
  sendCard: async () => "om_card",
  sendMarkdownCard: async () => {},
  updateCard: async () => {},
  createStreamingCard: async () => ({
    cardId: "7355372766134157313",
    messageId: "om_stream",
  }),
  updateStreamingCard: async () => {},
  finishStreamingCard: async () => {},
};

afterEach(() => {
  vi.useRealTimers();
});


describe("Feishu outbox routing and bounded output", () => {
  it("routes a rendered event to the exact account and chat", async () => {
    const sent: Array<{ chatId: string; format: string; text: string }> = [];
    const messagePort: FeishuMessagePort = {
      ...cardMethods,
      sendText: async (chatId, text) => {
        sent.push({ chatId, format: "text", text });
      },
      sendPost: async (chatId, text) => {
        sent.push({ chatId, format: "post", text });
      },
      sendMarkdownCard: async (chatId, text) => {
        sent.push({ chatId, format: "cardkit", text });
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

    expect(sent).toEqual([{
      chatId: "oc_chat",
      format: "cardkit",
      text: "飞书回复",
    }]);
  });

  it("ignores another surface, account, and non-critical progress", async () => {
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          sent.push(text);
        },
        sendPost: async (_chatId, text) => {
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
        ...cardMethods,
        sendText: async (chatId, text) => {
          started.push(`${chatId}:${text}`);
          if (text === "第一条") {
            await first.promise;
          }
          finished.push(`${chatId}:${text}`);
        },
        sendPost: async (chatId, text) => {
          started.push(`${chatId}:${text}`);
          if (text === "第一条") {
            await first.promise;
          }
          finished.push(`${chatId}:${text}`);
        },
        sendMarkdownCard: async (chatId, text) => {
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
        ...cardMethods,
        sendText: async (_chatId, text) => {
          sent.push(text);
        },
        sendPost: async (_chatId, text) => {
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
        ...cardMethods,
        sendText: async (_chatId, text) => {
          sent.push(text);
        },
        sendPost: async (_chatId, text) => {
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

  it("bounds static CardKit Markdown by element characters", async () => {
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          throw new Error(`unexpected post fallback: ${markdown}`);
        },
        sendMarkdownCard: async (_chatId, markdown) => {
          sent.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );
    const markdown = "\\\n\"".repeat(8_000);

    outbox.handle(completed({}, markdown));
    await outbox.close();

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThanOrEqual(5);
    expect(sent.every((chunk) => [...chunk].length <= 5_000)).toBe(true);
  });

  it("sends a static long final answer as one preview card and a text file", async () => {
    const operations: string[] = [];
    const files: Array<{
      chatId: string;
      fileName: string;
      file: Buffer;
    }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          operations.push(`card:${markdown}`);
        },
        sendFile: async (chatId, fileName, file) => {
          operations.push(`file:${fileName}`);
          files.push({ chatId, fileName, file });
        },
      },
      pino({ level: "silent" }),
    );
    const text = "长回复".repeat(10_000);

    outbox.handle(completed({}, text));
    await outbox.close();

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatch(/^card:/u);
    expect(operations[0]).toMatch(/\[内容预览，完整回复见附件\]$/u);
    expect([...operations[0]!.slice("card:".length)].length)
      .toBeLessThanOrEqual(5_000);
    expect(operations[1]).toBe("file:codex-final-answer.txt");
    expect(files).toEqual([{
      chatId: "oc_chat",
      fileName: "codex-final-answer.txt",
      file: Buffer.from(text, "utf8"),
    }]);
  });

  it("falls back to remaining bounded cards when a final-answer file fails", async () => {
    const cards: string[] = [];
    const text = "长回复".repeat(10_000);
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          cards.push(markdown);
        },
        sendFile: async () => {
          throw new FeishuMessageError(
            "send-failed",
            "飞书文件发送失败",
          );
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, text));
    await outbox.close();

    expect(cards).toHaveLength(5);
    expect(cards[0]).toMatch(/\[内容预览，完整回复见附件\]$/u);
    expect(cards[1]).toMatch(
      /^\[完整文件发送失败，已改为分段文本\]\n\n/u,
    );
    expect(cards.at(-1)).toMatch(/\[内容过长，已截断\]$/u);
  });

  it("consumes the native reply target after a preview even when its file fails", async () => {
    const ordinaryCards: string[] = [];
    const replies: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          ordinaryCards.push(markdown);
        },
        replyMarkdownCard: async (_messageId, markdown) => {
          replies.push(markdown);
        },
        sendFile: async () => {
          throw new FeishuMessageError(
            "send-failed",
            "飞书文件发送失败",
          );
        },
      },
      pino({ level: "silent" }),
    );
    outbox.prepareTurnReplyTarget("oc_chat", "om_origin");
    outbox.bindPendingTurnReplyTarget("oc_chat", "thread-1", "turn-1");

    outbox.handle(completed({}, "长回复".repeat(10_000)));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatch(/\[内容预览，完整回复见附件\]$/u);
    expect(replies[1]).toContain("本次运行 · 已完成");
  });

  it("does not upload a final answer beyond the bounded file limit", async () => {
    const cards: string[] = [];
    const sendFile = vi.fn(async () => {});
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          cards.push(markdown);
        },
        sendFile,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, "中".repeat(400_000)));
    await outbox.close();

    expect(sendFile).not.toHaveBeenCalled();
    expect(cards).toHaveLength(5);
    expect(cards.at(-1)).toMatch(/\[内容过长，已截断\]$/u);
  });

});
