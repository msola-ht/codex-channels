import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/index.js";
import {
  feishuCardElements,
  FeishuOutbox,
  type FeishuCardDocument,
} from "../src/surfaces/feishu/index.js";
import { completed, delta, operationUpdated, target, turnCompleted } from "./support/feishu-outbox-fixtures.js";


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

describe("Feishu outbox", () => {
  it("keeps one plan card and updates it in place", async () => {
    const sent: FeishuCardDocument[] = [];
    const updated: FeishuCardDocument[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard: async (_chatId, card) => {
          sent.push(card);
          return "om_plan";
        },
        updateCard: async (_messageId, card) => {
          updated.push(card);
        },
      },
      pino({ level: "silent" }),
      { planUpdatesEnabled: true },
    );

    outbox.handle(planUpdated([
      { step: "检查实现", status: "inProgress" },
      { step: "补充测试", status: "pending" },
    ]));
    outbox.handle(planUpdated([
      { step: "检查实现", status: "completed" },
      { step: "补充测试", status: "inProgress" },
    ]));
    outbox.handle(planUpdated([
      { step: "检查实现", status: "completed" },
      { step: "补充测试", status: "inProgress" },
    ]));
    await outbox.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.header.title.content).toBe("任务计划 · 0/2");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.header.title.content).toBe("任务计划 · 1/2");
    expect(statusCardText(updated[0]!)).toBe(
      "- ✓ 检查实现\n- ◐ 补充测试",
    );
  });

  it("sends the Turn start confirmation as a reply and creates the Thread status card", async () => {
    const sent: FeishuCardDocument[] = [];
    const replies: Array<{ messageId: string; markdown: string }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard: async (_chatId, card) => {
          sent.push(card);
          return "om_status";
        },
        replyMarkdownCard: async (messageId, markdown) => {
          replies.push({ messageId, markdown });
          return "om_started";
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
      identity: { kind: "plugin", name: "GitHub" },
    });
    await outbox.close();

    expect(replies).toEqual([{
      messageId: "om_origin",
      markdown: "## 已使用 GitHub Plugin 开始处理。",
    }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ schema: "2.0" });
    expect(sent[0]?.header.title.content).toBe("Session 状态");
    expect(statusCardText(sent[0]!)).toBe("GitHub Plugin · 运行中");
  });

  it("refreshes the existing Thread status card on the next Turn start", async () => {
    const sent: FeishuCardDocument[] = [];
    const updated: FeishuCardDocument[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard: async (_chatId, card) => {
          sent.push(card);
          return "om_status";
        },
        updateCard: async (_messageId, card) => {
          updated.push(card);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle({
      type: "turn.started",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    outbox.handle({
      type: "turn.started",
      target,
      threadId: "thread-1",
      turnId: "turn-2",
    });
    await outbox.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.header.title.content).toBe("Session 状态");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.header.title.content).toBe("Session 状态");
    expect(statusCardText(updated[0]!)).toBe("运行中");
  });

  it("keeps the same Thread status card when active repeats", async () => {
    const sent: FeishuCardDocument[] = [];
    const updated: FeishuCardDocument[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard: async (_chatId, card) => {
          sent.push(card);
          return "om_status";
        },
        updateCard: async (_messageId, card) => {
          updated.push(card);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle({
      type: "turn.started",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    outbox.handle({
      type: "thread.status",
      target,
      threadId: "thread-1",
      status: "active",
    });
    await outbox.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.header.title.content).toBe("Session 状态");
    expect(statusCardText(sent[0]!)).toBe("运行中");
    expect(updated).toHaveLength(0);
  });

  it("delivers Markdown through the ordered queue as a Markdown card", async () => {
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

    await outbox.deliverMarkdown("oc_chat", "## 测试\n- 名称：x");
    await outbox.close();

    expect(markdownCards).toEqual(["## 测试\n- 名称：x"]);
  });

  it("sends completed generated images even when operation summaries are hidden", async () => {
    const sentImages: Array<{ chatId: string; image: Buffer }> = [];
    const image = Buffer.from("validated-image");
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendImage: async (chatId, value) => {
          sentImages.push({ chatId, image: value });
        },
      },
      pino({ level: "silent" }),
      {
        operationUpdateDisplay: "hidden",
        readGeneratedImage: vi.fn(async () => ({
          bytes: image,
          format: "png" as const,
        })),
      },
    );

    const event = operationUpdated(
      "completed",
      "imageGeneration",
      "image-1",
    );
    outbox.handle({
      ...event,
      operation: {
        ...event.operation,
        imagePath: "/private/generated/image.png",
      },
    });
    await outbox.close();

    expect(sentImages).toEqual([{
      chatId: "oc_chat",
      image,
    }]);
  });

  it("sends a channel image through the ordered delivery queue", async () => {
    const sentImages: Array<{ chatId: string; image: Buffer }> = [];
    const image = Buffer.from("validated-image");
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendImage: async (chatId, value) => {
          sentImages.push({ chatId, image: value });
        },
      },
      pino({ level: "silent" }),
      {
        readGeneratedImage: vi.fn(async () => ({
          bytes: image,
          format: "png" as const,
        })),
      },
    );

    await outbox.sendChannelImage("oc_chat", "/private/generated/image.png");
    await outbox.close();

    expect(sentImages).toEqual([{
      chatId: "oc_chat",
      image,
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

    expect(markdownCards).toEqual([]);
    expect(replies).toEqual([
      { messageId: "om_origin", markdown: "处理中" },
      { messageId: "om_origin", markdown: "最终回复" },
    ]);
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

    expect(ordinaryCards).toEqual([]);
    expect(replyCards).toEqual([
      { messageId: "om_origin", text: "处理中" },
      { messageId: "om_origin", text: "最终回复" },
    ]);
  });

  it("keeps Turn completion separate from a commentary-only stream", async () => {
    vi.useFakeTimers();
    const finished: Array<{ summary: string; footer?: string }> = [];
    const staticCards: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          staticCards.push(markdown);
        },
        createStreamingCard: async () => ({
          cardId: "7355372766134157313",
          messageId: "om_commentary",
        }),
        finishStreamingCard: async (
          _cardId,
          _sequence,
          summary,
          footer?: string,
        ) => {
          finished.push({
            summary,
            ...(footer === undefined ? {} : { footer }),
          });
        },
      },
      pino({ level: "silent" }),
    );

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
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(finished).toEqual([{ summary: "处理中" }]);
    expect(staticCards).toEqual([turnCompletedMarkdown]);
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
      `static:${turnCompletedMarkdown}`,
    ]);
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

function planUpdated(
  steps: Extract<OutputEvent, { type: "plan.updated" }>["steps"],
): Extract<OutputEvent, { type: "plan.updated" }> {
  return {
    type: "plan.updated",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    explanation: null,
    steps,
  };
}

function statusCardText(card: FeishuCardDocument): string {
  const element = feishuCardElements(card)[0] as {
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

export function deferredValue<T>(): {
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

export function statusBindingCount(outbox: FeishuOutbox): number {
  return (
    outbox as unknown as {
      threadStatusMessages: ReadonlyMap<string, unknown>;
    }
  ).threadStatusMessages.size;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
