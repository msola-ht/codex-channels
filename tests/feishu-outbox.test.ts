import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationTarget,
  OutputEvent,
} from "../src/conversation-core/index.js";
import {
  FeishuMessageError,
  FeishuOutbox,
  type FeishuCardDocument,
  type FeishuMessagePort,
} from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu",
  accountId: "cli_app",
  conversationId: "oc_chat",
} as const;

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

describe("Feishu outbox", () => {
  it("sends the shared Turn start confirmation as a Markdown card", async () => {
    const markdownCards: string[] = [];
    const replies: Array<{ messageId: string; markdown: string }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        replyMarkdownCard: async (messageId, markdown) => {
          replies.push({ messageId, markdown });
        },
      },
      pino({ level: "silent" }),
    );

    outbox.prepareTurnReplyTarget("oc_chat", "om_origin");
    outbox.handle({
      type: "turn.started",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await outbox.close();

    expect(markdownCards).toEqual([]);
    expect(replies).toEqual([{
      messageId: "om_origin",
      markdown: "**已开始处理。**",
    }]);
  });

  it("keeps the reply target through commentary for the final static reply", async () => {
    const markdownCards: string[] = [];
    const replies: Array<{ messageId: string; markdown: string }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        replyMarkdownCard: async (messageId, markdown) => {
          replies.push({ messageId, markdown });
        },
      },
      pino({ level: "silent" }),
    );

    outbox.prepareTurnReplyTarget("oc_chat", "om_origin");
    outbox.bindPendingTurnReplyTarget("oc_chat", "thread-1", "turn-1");
    outbox.handle({
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "commentary-1",
      text: "处理中",
      phase: "commentary",
    });
    outbox.handle({
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "final-1",
      text: "最终回复",
      phase: "final_answer",
    });
    await outbox.close();

    expect(markdownCards).toEqual(["处理中"]);
    expect(replies).toEqual([{
      messageId: "om_origin",
      markdown: "最终回复",
    }]);
  });

  it("keeps the reply target through commentary for the final streaming card", async () => {
    vi.useFakeTimers();
    const ordinaryCards: string[] = [];
    const replyCards: Array<{ messageId: string; text: string }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        createStreamingCard: async (_chatId, initialText) => {
          ordinaryCards.push(initialText);
          return {
            cardId: "7355372766134157313",
            messageId: "om_commentary",
          };
        },
        createStreamingReplyCard: async (messageId, initialText) => {
          replyCards.push({ messageId, text: initialText });
          return {
            cardId: "7355372766134157314",
            messageId: "om_final",
          };
        },
      },
      pino({ level: "silent" }),
    );

    outbox.prepareTurnReplyTarget("oc_chat", "om_origin");
    outbox.bindPendingTurnReplyTarget("oc_chat", "thread-1", "turn-1");
    outbox.handle({
      type: "text.delta",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "commentary-1",
      text: "处理中",
      phase: "commentary",
    });
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle({
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "commentary-1",
      text: "处理中",
      phase: "commentary",
    });
    outbox.handle({
      type: "text.delta",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "final-1",
      text: "最终回复",
      phase: "final_answer",
    });
    await vi.advanceTimersByTimeAsync(300);
    outbox.handle({
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "final-1",
      text: "最终回复",
      phase: "final_answer",
    });
    await outbox.close();

    expect(ordinaryCards).toEqual(["处理中"]);
    expect(replyCards).toEqual([{
      messageId: "om_origin",
      text: "最终回复",
    }]);
  });

  it("streams coalesced deltas through one native CardKit card", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const updated: Array<{ content: string; sequence: number }> = [];
    const finished: Array<{ summary: string; sequence: number }> = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
        updateStreamingCard: async (_cardId, content, sequence) => {
          updated.push({ content, sequence });
        },
        finishStreamingCard: async (_cardId, sequence, summary) => {
          finished.push({ summary, sequence });
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("你好"));
    outbox.handle(delta("，世界"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("！"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "你好，世界！", "item-1"));
    await outbox.close();

    expect(created).toEqual(["你好，世界"]);
    expect(updated).toEqual([{
      content: "你好，世界！",
      sequence: 1,
    }]);
    expect(finished).toEqual([{
      summary: "你好，世界！",
      sequence: 2,
    }]);
    expect(posts).toEqual([]);
  });

  it("does not append a working footer to active Turn output", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const updated: string[] = [];
    const finished: string[] = [];
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
        updateStreamingCard: async (_cardId, content) => {
          updated.push(content);
        },
        finishStreamingCard: async (_cardId, _sequence, summary) => {
          finished.push(summary);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle(delta("正在处理"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("。"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "正在处理。", "item-1"));
    outbox.handle(operationUpdated("completed"));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(created).toEqual(["正在处理"]);
    expect(updated).toEqual(["正在处理。"]);
    expect(finished).toEqual(["正在处理。"]);
    expect(markdownCards[0]).not.toContain("工作中");
    expect(markdownCards.at(-1)).toBe("**本次运行 · 已完成**");
  });

  it("uses the full streaming element budget without a footer", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
      },
      pino({ level: "silent" }),
    );
    const text = "长".repeat(5_000);

    outbox.handle(threadStatus("active"));
    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(created).toEqual([text]);
  });

  it("sends a short reply without a working footer", async () => {
    vi.useFakeTimers();
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle(delta("短回复"));
    outbox.handle(completed({}, "短回复", "item-1"));
    await outbox.close();

    expect(markdownCards).toEqual(["短回复"]);
  });

  it("bounds concurrent native streaming states", async () => {
    vi.useFakeTimers();
    const createStreamingCard = vi.fn(async () => ({
      cardId: "7355372766134157313",
      messageId: "om_stream",
    }));
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        createStreamingCard,
        sendText: async () => {},
        sendPost: async () => {},
      },
      pino({ level: "silent" }),
    );

    for (let index = 0; index < 101; index += 1) {
      outbox.handle(delta("增量", `item-${index}`));
    }
    await vi.advanceTimersByTimeAsync(300);
    await outbox.close();

    expect(createStreamingCard).toHaveBeenCalledTimes(100);
  });

  it("keeps a reply as one static CardKit card when it completes before streaming starts", async () => {
    vi.useFakeTimers();
    const createStreamingCard = vi.fn(cardMethods.createStreamingCard);
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        createStreamingCard,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          throw new Error(`unexpected post fallback: ${markdown}`);
        },
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("短回复"));
    outbox.handle(completed({}, "短回复", "item-1"));
    await outbox.close();

    expect(createStreamingCard).not.toHaveBeenCalled();
    expect(markdownCards).toEqual(["短回复"]);
  });

  it("logs and safely falls back to rich post when static CardKit creation fails", async () => {
    const posts: string[] = [];
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        sendMarkdownCard: async () => {
          throw new FeishuMessageError(
            "card-create-failed",
            "飞书静态卡片创建失败",
          );
        },
      },
      logger,
    );

    outbox.handle(completed({}, "飞书回复"));
    await outbox.close();

    expect(posts).toEqual(["飞书回复"]);
    expect(warn).toHaveBeenCalledWith(
      {
        component: "Feishu",
        fallback: "post",
      },
      "飞书静态 CardKit 创建失败，已降级为富文本",
    );
  });

  it("does not duplicate a message after an ambiguous static CardKit send failure", async () => {
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        sendMarkdownCard: async () => {
          throw new FeishuMessageError("send-failed", "飞书消息发送失败");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, "飞书回复"));
    await outbox.close();

    expect(posts).toEqual([]);
  });

  it("falls back to the complete rich post after streaming creation fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async () => {
          throw new Error("stream failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("正文"));
    outbox.handle(completed({}, "部分正文", "item-1"));
    await outbox.close();

    expect(posts).toEqual(["部分正文"]);
  });

  it("marks a bounded rich-post fallback as truncated after streaming creation fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async () => {
          throw new Error("stream failed");
        },
      },
      pino({ level: "silent" }),
    );
    const text = "长".repeat(30_000);

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(posts).toHaveLength(4);
    expect(posts.at(-1)).toContain("[内容过长，已截断]");
  });

  it("uses the final short reply as the truncation source after streaming creation fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async () => {
          throw new Error("stream failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("长".repeat(30_000)));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "最终短回复", "item-1"));
    await outbox.close();

    expect(posts).toEqual(["最终短回复"]);
  });

  it("falls back to the complete rich post after a streaming update fails", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const finishStreamingCard = vi.fn(async () => {});
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        updateStreamingCard: async () => {
          throw new Error("stream update failed");
        },
        finishStreamingCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("正文"));
    outbox.handle(completed({}, "部分正文", "item-1"));
    await outbox.close();

    expect(finishStreamingCard).toHaveBeenCalledWith(
      "7355372766134157313",
      2,
      "部分",
    );
    expect(posts).toEqual(["部分正文"]);
  });

  it("skips a rate-limited intermediate frame and continues the stream", async () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const updates: Array<{ content: string; sequence: number }> = [];
    const finishStreamingCard = vi.fn(async () => {});
    let updateCount = 0;
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        updateStreamingCard: async (_cardId, content, sequence) => {
          updates.push({ content, sequence });
          updateCount += 1;
          if (updateCount === 1) {
            throw new FeishuMessageError(
              "rate-limited",
              "飞书流式卡片更新请求受限",
            );
          }
        },
        finishStreamingCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(delta("继续"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "部分正文继续", "item-1"));
    await outbox.close();

    expect(updates).toEqual([
      { content: "部分正文", sequence: 1 },
      { content: "部分正文继续", sequence: 2 },
    ]);
    expect(finishStreamingCard).toHaveBeenCalledWith(
      "7355372766134157313",
      3,
      "部分正文继续",
    );
    expect(posts).toEqual([]);
  });

  it("rolls a long fenced reply into bounded native streaming cards", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const finished: string[] = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
        finishStreamingCard: async (_cardId, _sequence, summary) => {
          finished.push(summary);
        },
      },
      pino({ level: "silent" }),
    );
    const text = `\`\`\`ts\n${"const value = 1;\n".repeat(400)}\`\`\``;

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(created).toHaveLength(2);
    expect(created.every((part) => [...part].length <= 5_000)).toBe(true);
    expect(created[0]).toMatch(/\n```$/u);
    expect(created[1]).toMatch(/^```ts\n/u);
    expect(finished).toHaveLength(2);
    expect(posts).toEqual([]);
  });

  it("appends a complete text file after an oversized streaming reply", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const files: Buffer[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          operations.push(`text:${text}`);
        },
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          operations.push(`static:${markdown}`);
        },
        createStreamingCard: async (_chatId, initialText) => {
          operations.push(`create:${initialText}`);
          return {
            cardId: `73553727661341573${operations.length}`,
            messageId: `om_stream_${operations.length}`,
          };
        },
        finishStreamingCard: async () => {
          operations.push("finish");
        },
        sendFile: async (_chatId, fileName, file) => {
          operations.push(`file:${fileName}`);
          files.push(file);
        },
      },
      pino({ level: "silent" }),
    );
    const text = "流式长回复".repeat(6_000);

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(operations.at(-1)).toBe("file:codex-final-answer.txt");
    expect(files).toEqual([Buffer.from(text, "utf8")]);
  });

  it("keeps streaming cards and fallback posts within one five-message budget", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const markdownCards: string[] = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
      },
      pino({ level: "silent" }),
    );
    const text = ["甲", "乙", "丙", "丁", "戊", "己"]
      .map((character) => character.repeat(5_000))
      .join("");

    outbox.handle(delta(text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, text, "item-1"));
    await outbox.close();

    expect(created).toHaveLength(4);
    expect(markdownCards).toHaveLength(1);
    expect(posts).toEqual([]);
    expect(markdownCards[0]).toMatch(/\[内容过长，已截断\]$/u);
    const displayedText = [
      ...created,
      markdownCards[0]!.replace(/\n\n\[内容过长，已截断\]$/u, ""),
    ].join("");
    expect(text.startsWith(displayedText)).toBe(true);
    expect(
      created.length + markdownCards.length + posts.length,
    ).toBeLessThanOrEqual(5);
  });

  it("reserves the fifth message for a corrected final reply", async () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const posts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async (_chatId, markdown) => {
          posts.push(markdown);
        },
        createStreamingCard: async (_chatId, initialText) => {
          created.push(initialText);
          return {
            cardId: `73553727661341573${created.length}`,
            messageId: `om_stream_${created.length}`,
          };
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("长".repeat(30_000)));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "最终校正回复", "item-1"));
    await outbox.close();

    expect(created).toHaveLength(4);
    expect(posts).toEqual(["最终校正回复"]);
    expect(created.length + posts.length).toBeLessThanOrEqual(5);
  });

  it("finishes an active native stream before a Turn completion status", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          operations.push(`text:${text}`);
        },
        sendPost: async (_chatId, text) => {
          operations.push(`post:${text}`);
        },
        sendMarkdownCard: async (_chatId, text) => {
          operations.push(`static:${text}`);
        },
        createStreamingCard: async (_chatId, initialText) => {
          operations.push(`create:${initialText}`);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
        finishStreamingCard: async () => {
          operations.push("finish");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(operations).toEqual([
      "create:部分正文",
      "finish",
      "static:**本次运行 · 已完成**",
    ]);
  });

  it("preserves a short partial reply when Turn completion arrives first", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          operations.push(`text:${text}`);
        },
        sendPost: async (_chatId, text) => {
          operations.push(`post:${text}`);
        },
        sendMarkdownCard: async (_chatId, text) => {
          operations.push(`static:${text}`);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分正文"));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(operations).toEqual([
      "static:部分正文",
      "static:**本次运行 · 已完成**",
    ]);
  });

  it("keeps completed tools as static CardKit cards in conversation order", async () => {
    const operations: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          operations.push(`text:${text}`);
        },
        sendPost: async (_chatId, text) => {
          operations.push(`post:${text}`);
        },
        sendMarkdownCard: async (_chatId, text) => {
          operations.push(`static:${text}`);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(completed({}, "工具前说明", "message-1"));
    outbox.handle(operationUpdated("running"));
    outbox.handle(operationUpdated("completed"));
    outbox.handle(completed({}, "工具执行结果", "message-2"));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(operations).toHaveLength(4);
    expect(operations[0]).toBe("static:工具前说明");
    expect(operations[1]).toContain("static:**运行命令 · 已完成**");
    expect(operations[1]).toContain("git status --short");
    expect(operations[2]).toBe("static:工具执行结果");
    expect(operations[3]).toBe("static:**本次运行 · 已完成**");
  });

  it("ignores running operation frames and sends one static terminal card", async () => {
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(operationUpdated("running"));
    outbox.handle(operationUpdated("completed"));
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards).toHaveLength(2);
    expect(markdownCards[0]).not.toContain("**执行进度**");
    expect(markdownCards[0]).toContain("git status --short");
    expect(markdownCards[0]).toContain("已完成");
    expect(markdownCards[1]).toBe("**本次运行 · 已完成**");
  });

  it("does not send operation updates in hidden mode", async () => {
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
      { operationUpdateDisplay: "hidden" },
    );

    outbox.handle(operationUpdated("running"));
    outbox.handle(operationUpdated("completed"));
    await settle();

    expect(markdownCards).toEqual([]);

    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards).toEqual(["**本次运行 · 已完成**"]);
  });

  it("sends a compact operation body with a duration footer", async () => {
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
      { operationUpdateDisplay: "compact" },
    );

    outbox.handle(operationUpdated("completed"));
    await settle();
    await outbox.close();

    expect(markdownCards).toEqual([
      "**运行命令 · 已完成** · exit 0 · `git status --short`\n\n"
      + "---\n"
      + "**耗时：** 125毫秒",
    ]);
  });

  it("summarizes repeated query operations once before Turn completion", async () => {
    const markdownCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(operationUpdated("completed", "mcpTool", "mcp-1"));
    outbox.handle(operationUpdated("completed", "mcpTool", "mcp-2"));
    await settle();
    expect(markdownCards).toEqual([]);

    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards).toEqual([
      "**工具查询 · 已完成**\n- MCP 工具：2 次\n\n"
      + "---\n**耗时：** 250毫秒",
      "**本次运行 · 已完成**",
    ]);
  });

  it("updates one thread status card from active to idle", async () => {
    const sent: Array<{
      chatId: string;
      card: FeishuCardDocument;
    }> = [];
    const updated: Array<{
      messageId: string;
      card: FeishuCardDocument;
    }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendCard: async (chatId, card) => {
          sent.push({ chatId, card });
          return "om_status";
        },
        sendPost: async () => {},
        updateCard: async (messageId, card) => {
          updated.push({ messageId, card });
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle(threadStatus("active"));
    outbox.handle(threadStatus("idle"));
    await outbox.close();

    expect(sent).toEqual([{
      chatId: "oc_chat",
      card: {
        config: {
          update_multi: true,
          wide_screen_mode: true,
        },
        header: {
          template: "blue",
          title: {
            tag: "plain_text",
            content: "Thread 状态",
          },
        },
        elements: [{
          tag: "div",
          text: {
            tag: "plain_text",
            content: "运行中",
          },
        }],
      },
    }]);
    expect(updated).toEqual([{
      messageId: "om_status",
      card: {
        config: {
          update_multi: true,
          wide_screen_mode: true,
        },
        header: {
          template: "green",
          title: {
            tag: "plain_text",
            content: "Thread 状态",
          },
        },
        elements: [{
          tag: "div",
          text: {
            tag: "plain_text",
            content: "空闲",
          },
        }],
      },
    }]);
  });

  it("drops a stale status binding after an update failure", async () => {
    const created: string[] = [];
    let updateAttempts = 0;
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard: async (_chatId, card) => {
          created.push(statusCardText(card));
          return `om_status_${created.length}`;
        },
        updateCard: async () => {
          updateAttempts += 1;
          throw new Error("update failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle(threadStatus("idle"));
    outbox.handle(threadStatus("active"));
    await outbox.close();

    expect(created).toEqual([
      "运行中",
      "运行中",
    ]);
    expect(updateAttempts).toBe(1);
  });

  it("does not restore a status binding after close times out", async () => {
    vi.useFakeTimers();
    const creation = deferredValue<string>();
    const sendCard = vi.fn(() => creation.promise);
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sendCard).toHaveBeenCalledOnce();

    const closing = outbox.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(statusBindingCount(outbox)).toBe(0);

    creation.resolve("om_late");
    await Promise.resolve();
    await Promise.resolve();
    expect(statusBindingCount(outbox)).toBe(0);
  });

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

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/\[内容预览，完整回复见附件\]$/u);
    expect(ordinaryCards.at(-1)).toBe("**本次运行 · 已完成**");
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

  it("waits for accepted output during close and rejects later events", async () => {
    const pending = deferred();
    const sent: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          await pending.promise;
          sent.push(text);
        },
        sendPost: async (_chatId, text) => {
          await pending.promise;
          sent.push(text);
        },
        sendMarkdownCard: async (_chatId, text) => {
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
  itemId = text,
): OutputEvent {
  return {
    type: "text.completed",
    target: { ...target, ...targetOverrides },
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
  };
}

function operationUpdated(
  status: "running" | "completed",
  kind: Extract<
    OutputEvent,
    { type: "operation.updated" }
  >["operation"]["kind"] = "command",
  itemId = "command-1",
): OutputEvent {
  return {
    type: "operation.updated",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    operation: {
      itemId,
      kind,
      detail: "git status --short",
      status,
      ...(status === "completed"
        ? { durationMs: 125, exitCode: 0 }
        : {}),
    },
  };
}

function delta(text: string, itemId = "item-1"): OutputEvent {
  return {
    type: "text.delta",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
  };
}

function threadStatus(status: string): OutputEvent {
  return {
    type: "thread.status",
    target,
    threadId: "thread-1",
    status,
  };
}

function turnCompleted(): OutputEvent {
  return {
    type: "turn.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
}

function statusCardText(card: FeishuCardDocument): string {
  const element = card.elements[0] as {
    text?: {
      content?: unknown;
    };
  } | undefined;
  return typeof element?.text?.content === "string"
    ? element.text.content
    : "";
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

function deferredValue<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
  };
}

function statusBindingCount(outbox: FeishuOutbox): number {
  return (
    outbox as unknown as {
      threadStatusMessages: ReadonlyMap<string, unknown>;
    }
  ).threadStatusMessages.size;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
