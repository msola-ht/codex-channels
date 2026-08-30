import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuOutbox,
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

describe("Feishu outbox thinking and runtime display", () => {
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

});
