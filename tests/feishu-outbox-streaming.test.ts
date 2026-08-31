import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeishuMessageError,
  FeishuOutbox,
} from "../src/surfaces/feishu/index.js";
import { completed, delta, operationUpdated, threadStatus, turnCompleted } from "./support/feishu-outbox-fixtures.js";


const turnCompletedMarkdown = "## 本次运行 · 已完成\n\n- Session：测试会话\n- Session ID：thread-1";

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


describe("Feishu outbox streaming lifecycle", () => {
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

  it("flushes pending streamed text before a visible operation result", async () => {
    vi.useFakeTimers();
    const operations: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          operations.push(`operation:${markdown}`);
        },
        createStreamingCard: async (_chatId, initialText) => {
          operations.push(`stream:${initialText}`);
          return {
            cardId: "7355372766134157313",
            messageId: "om_stream",
          };
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("先说明，再执行命令。"));
    outbox.handle(operationUpdated("completed"));
    await outbox.close();

    expect(operations[0]).toBe("stream:先说明，再执行命令。");
    expect(operations[1]).toMatch(/^operation:\*\*运行命令/u);
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
        finishStreamingCard: async (
          _cardId,
          _sequence,
          summary,
          footer?: string,
        ) => {
          finished.push(`${summary}|${footer ?? ""}`);
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
    expect(finished).toEqual([
      `正在处理。|${turnCompletedMarkdown}`,
    ]);
    expect(markdownCards[0]).not.toContain("工作中");
    expect(markdownCards.at(-1)).toContain("**运行命令 · 已完成**");
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
    let resolveInitialFinish!: () => void;
    const initialFinish = new Promise<void>((resolve) => {
      resolveInitialFinish = resolve;
    });
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
        finishStreamingCard: async (
          _cardId,
          _sequence,
          summary,
          footer?: string,
        ) => {
          operations.push(`finish:${summary}|${footer ?? ""}`);
          if (footer === undefined) {
            resolveInitialFinish();
          }
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(completed({}, "部分正文", "item-1"));
    await initialFinish;
    await Promise.resolve();
    await Promise.resolve();
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(operations).toEqual([
      "create:部分正文",
      "finish:部分正文|",
      `finish:部分正文|${turnCompletedMarkdown}`,
    ]);
  });

  it("falls back to a static completion status when finishing a stream fails", async () => {
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
        finishStreamingCard: async () => {
          throw new Error("stream finish failed");
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle(delta("部分正文"));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards).toEqual([turnCompletedMarkdown]);
    expect(streamCount(outbox)).toBe(0);
  });

});

function streamCount(outbox: FeishuOutbox): number {
  return (outbox as unknown as { streams: ReadonlyMap<string, unknown> }).streams.size;
}
