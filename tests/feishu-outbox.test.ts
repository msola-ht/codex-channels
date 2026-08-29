import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationTarget,
  OutputEvent,
} from "../src/conversation-core/index.js";
import {
  feishuCardElements,
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

  it("streams the thinking status as one streaming card per segment", async () => {
    const created: Array<{ chatId: string; initialText: string }> = [];
    const updated: Array<{
      cardId: string;
      content: string;
      sequence: number;
    }> = [];
    const finished: Array<{
      cardId: string;
      sequence: number;
      summary: string;
    }> = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        createStreamingCard: async (chatId, initialText) => {
          created.push({ chatId, initialText });
          return {
            cardId: `om_reason_${created.length}`,
            messageId: `om_reason_msg_${created.length}`,
          };
        },
        updateStreamingCard: async (cardId, content, sequence) => {
          updated.push({ cardId, content, sequence });
        },
        finishStreamingCard: async (cardId, sequence, summary) => {
          finished.push({ cardId, sequence, summary });
        },
      },
      pino({ level: "silent" }),
    );

    const reasoning = (
      elapsedMs: number,
      final?: boolean,
    ): void => {
      outbox.handle({
        type: "turn.reasoning",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        summary: "",
        elapsedMs,
        ...(final === undefined ? {} : { final }),
      });
    };
    reasoning(0);
    reasoning(3_000);
    reasoning(15_000, true);
    reasoning(0);
    reasoning(2_000, true);
    await outbox.close();

    expect(created).toEqual([
      { chatId: "oc_chat", initialText: "## 思考中…" },
      { chatId: "oc_chat", initialText: "## 思考中…" },
    ]);
    expect(updated).toEqual([
      {
        cardId: "om_reason_1",
        content: "## 思考中…\n\n---\n**耗时：** 3秒",
        sequence: 1,
      },
      {
        cardId: "om_reason_1",
        content: "## 思考中…\n\n---\n**耗时：** 15秒",
        sequence: 2,
      },
      {
        cardId: "om_reason_2",
        content: "## 思考中…\n\n---\n**耗时：** 2秒",
        sequence: 1,
      },
    ]);
    expect(finished).toEqual([
      {
        cardId: "om_reason_1",
        sequence: 3,
        summary: "## 思考中…\n\n---\n**耗时：** 15秒",
      },
      {
        cardId: "om_reason_2",
        sequence: 2,
        summary: "## 思考中…\n\n---\n**耗时：** 2秒",
      },
    ]);
  });

  it("falls back to a Markdown card for a final-only thinking notice", async () => {
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

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 15_000,
      final: true,
    });
    await outbox.close();

    expect(markdownCards).toEqual(["## 思考中…\n\n---\n**耗时：** 15秒"]);
  });

  it("does not let an old thinking-card failure delete a newer segment", async () => {
    const created: string[] = [];
    let resolveSecondCreated!: () => void;
    const secondCreated = new Promise<void>((resolve) => {
      resolveSecondCreated = resolve;
    });
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async () => {},
        createStreamingCard: async () => {
          const cardId = `om_reason_${created.length + 1}`;
          created.push(cardId);
          if (created.length === 2) resolveSecondCreated();
          return { cardId, messageId: `${cardId}_message` };
        },
        updateStreamingCard: async (cardId) => {
          if (cardId === "om_reason_1") {
            throw new Error("old card failed");
          }
        },
      },
      pino({ level: "silent" }),
    );
    const reasoning = (elapsedMs: number, final?: boolean): void => {
      void outbox.handle({
        type: "turn.reasoning",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        summary: "",
        elapsedMs,
        ...(final === undefined ? {} : { final }),
      });
    };

    reasoning(0);
    reasoning(1_000, true);
    reasoning(0);
    await secondCreated;
    reasoning(1_000);
    await outbox.close();

    expect(created).toEqual(["om_reason_1", "om_reason_2"]);
  });

  it("does not log credentials when a thinking card fails", async () => {
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async () => {},
        createStreamingCard: async () => {
          throw new Error("Authorization: Bearer thinking-secret");
        },
      },
      logger,
    );

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-secret",
      turnId: "turn-secret",
      summary: "",
      elapsedMs: 0,
    });
    await outbox.close();

    expect(JSON.stringify(warn.mock.calls)).not.toContain("thinking-secret");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "Feishu",
        errorType: "Error",
      }),
      "飞书思考流式卡创建失败，回退普通卡片",
    );
  });

  it("does not send thinking status when reasoning display is disabled", async () => {
    const markdownCards: string[] = [];
    const created: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
        createStreamingCard: async () => {
          created.push("card");
          return { cardId: "om_reason", messageId: "om_reason_msg" };
        },
      },
      pino({ level: "silent" }),
      { reasoningEnabled: false },
    );

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 0,
    });
    await outbox.close();

    expect(markdownCards).toEqual([]);
    expect(created).toEqual([]);
  });

  it("sends the subagent start notice as a Markdown card instead of plain text", async () => {
    const markdownCards: string[] = [];
    const texts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          texts.push(text);
        },
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle({
      type: "subagent.spawned",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    });
    await outbox.close();

    expect(texts).toEqual([]);
    expect(markdownCards).toEqual(["## 子代理开始 · review_task"]);
  });

  it("sends the subagent follow-up notice as a Markdown card", async () => {
    const markdownCards: string[] = [];
    const texts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          texts.push(text);
        },
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle({
      type: "subagent.contacted",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    });
    await outbox.close();

    expect(texts).toEqual([]);
    expect(markdownCards).toEqual(["## 子代理继续 · review_task"]);
  });

  it("renders runtime status updates as Markdown cards", async () => {
    const markdownCards: string[] = [];
    const texts: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async (_chatId, text) => {
          texts.push(text);
        },
        sendPost: async () => {},
        sendMarkdownCard: async (_chatId, markdown) => {
          markdownCards.push(markdown);
        },
      },
      pino({ level: "silent" }),
    );

    outbox.handle({
      type: "mcp.status.updated",
      target,
      threadId: null,
      name: "codex_apps",
      status: "ready",
      error: null,
      failureReason: null,
    });
    outbox.handle({
      type: "mcp.oauth.completed",
      target,
      threadId: null,
      name: "codex_apps",
      success: false,
      error: "OAuth denied",
    });
    outbox.handle({
      type: "account.updated",
      target,
      authMode: "apikey",
      planType: "pro",
    });
    await outbox.close();

    expect(texts).toEqual([]);
    expect(markdownCards).toEqual([
      "## MCP Server\n- 名称：codex_apps\n- 状态：已就绪",
      "## MCP OAuth\n- 名称：codex_apps\n- 状态：登录失败\n- 原因：OAuth denied",
      "## Codex 账户状态已更新\n- 认证：apikey\n- 套餐：Pro",
    ]);
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
    expect(operations[3]).toBe(`static:${turnCompletedMarkdown}`);
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
    expect(markdownCards[1]).toBe(turnCompletedMarkdown);
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

    expect(markdownCards).toEqual([turnCompletedMarkdown]);
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

  it("hides successful wait calls but keeps subagent failures in compact mode", async () => {
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

    outbox.handle({
      ...operationUpdated("completed", "subagent", "wait-1"),
      operation: {
        itemId: "wait-1",
        kind: "subagent",
        action: "wait",
        status: "completed",
        durationMs: 125,
      },
    });
    outbox.handle({
      ...operationUpdated("completed", "subagent", "wait-2"),
      operation: {
        itemId: "wait-2",
        kind: "subagent",
        action: "wait",
        status: "failed",
        durationMs: 125,
      },
    });
    await outbox.close();

    expect(markdownCards).toEqual([
      "**等待子代理 · 失败**\n\n---\n"
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

    outbox.handle(operationUpdated(
      "completed",
      "mcpTool",
      "mcp-1",
      "codex_apps.github.fetch_pr",
    ));
    outbox.handle(operationUpdated(
      "completed",
      "mcpTool",
      "mcp-2",
      "codex_apps.github.fetch_pr",
    ));
    outbox.handle(operationUpdated(
      "completed",
      "mcpTool",
      "mcp-3",
      "codex_apps.github.update_pull_request",
    ));
    await settle();
    expect(markdownCards).toEqual([]);

    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards).toEqual([
      "**工具查询 · 已完成**\n"
      + "- MCP 工具：3 次\n"
      + "  - `codex_apps.github.fetch_pr · 读写属性未知`：2 次\n"
      + "  - `codex_apps.github.update_pull_request · 读写属性未知`：1 次\n\n"
      + "---\n**耗时：** 375毫秒",
      turnCompletedMarkdown,
    ]);
  });

  it("bounds distinct query operation details in the Turn summary", async () => {
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

    for (let index = 1; index <= 10; index += 1) {
      outbox.handle(operationUpdated(
        "completed",
        "mcpTool",
        `mcp-${index}`,
        `codex_apps.github.tool_${index}`,
      ));
    }
    outbox.handle(turnCompleted());
    await outbox.close();

    expect(markdownCards[0]).toContain("- MCP 工具：10 次");
    expect(markdownCards[0]).toContain("`codex_apps.github.tool_8 · 读写属性未知`：1 次");
    expect(markdownCards[0]).toContain("其余 2 项明细已省略");
    expect(markdownCards[0]).not.toContain("codex_apps.github.tool_9");
  });

  it("sends a completed web search immediately before the final answer", async () => {
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

    outbox.handle(operationUpdated("completed", "webSearch", "search-1"));
    await settle();

    expect(markdownCards).toHaveLength(1);
    expect(markdownCards[0]).toContain("搜索网页 · 已完成");

    outbox.handle(completed({}, "最终回复"));
    await outbox.close();

    expect(markdownCards[1]).toBe("最终回复");
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
        schema: "2.0",
        config: {
          update_multi: true,
          wide_screen_mode: true,
        },
        header: {
          template: "blue",
          title: {
            tag: "plain_text",
            content: "Session 状态",
          },
        },
        body: {
          elements: [{
            tag: "div",
            text: {
              tag: "plain_text",
              content: "运行中",
            },
          }],
        },
      },
    }]);
    expect(updated).toEqual([{
      messageId: "om_status",
      card: {
        schema: "2.0",
        config: {
          update_multi: true,
          wide_screen_mode: true,
        },
        header: {
          template: "green",
          title: {
            tag: "plain_text",
            content: "Session 状态",
          },
        },
        body: {
          elements: [{
            tag: "div",
            text: {
              tag: "plain_text",
              content: "处理结束 · 结果见下方消息",
            },
          }],
        },
      },
    }]);
  });

  it("keeps the foreground Thread status card across active and idle", async () => {
    const sent: FeishuCardDocument[] = [];
    const updateCard = vi.fn(async () => {});
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
        updateCard,
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
    outbox.handle(threadStatus("active"));
    outbox.handle(threadStatus("idle"));
    await outbox.close();

    expect(sent).toHaveLength(1);
    expect(statusCardText(sent[0]!)).toBe("GitHub Plugin · 运行中");
    expect(updateCard).toHaveBeenCalledWith(
      "om_status",
      expect.objectContaining({
        header: expect.objectContaining({ template: "green" }),
        body: expect.objectContaining({
          elements: [expect.objectContaining({
            text: expect.objectContaining({
              content: "GitHub Plugin · 处理结束 · 结果见下方消息",
            }),
          })],
        }),
      }),
    );
  });

  it("does not add a Turn start card after an active Thread status card", async () => {
    const sendMarkdownCard = vi.fn(async () => "om_started");
    const sendCard = vi.fn(async () => "om_status");
    const updateCard = vi.fn(async () => {});
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendMarkdownCard,
        sendCard,
        updateCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("active"));
    outbox.handle({
      type: "turn.started",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      identity: { kind: "plugin", name: "GitHub" },
    });
    await outbox.close();

    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCard).not.toHaveBeenCalled();
    expect(updateCard).toHaveBeenCalledWith(
      "om_status",
      expect.objectContaining({
        body: expect.objectContaining({
          elements: [expect.objectContaining({
            text: expect.objectContaining({
              content: "GitHub Plugin · 运行中",
            }),
          })],
        }),
      }),
    );
  });

  it("does not create a standalone idle thread status card", async () => {
    const sendCard = vi.fn(async () => "om_status");
    const updateCard = vi.fn(async () => {});
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        sendText: async () => {},
        sendPost: async () => {},
        sendCard,
        updateCard,
      },
      pino({ level: "silent" }),
    );

    outbox.handle(threadStatus("idle"));
    await outbox.close();

    expect(sendCard).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
  });

  it("rebuilds the Thread status card after an update failure", async () => {
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
      "处理结束 · 结果见下方消息",
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
  detail = "git status --short",
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    operation: {
      itemId,
      kind,
      detail,
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
    sessionName: "测试会话",
    turnId: "turn-1",
    status: "completed",
  };
}

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

function streamCount(outbox: FeishuOutbox): number {
  return (
    outbox as unknown as {
      streams: ReadonlyMap<string, unknown>;
    }
  ).streams.size;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
