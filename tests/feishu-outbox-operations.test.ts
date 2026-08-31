import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuOutbox,
} from "../src/surfaces/feishu/index.js";
import { completed, operationUpdated, turnCompleted } from "./support/feishu-outbox-fixtures.js";


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


describe("Feishu outbox operation summaries", () => {
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

  it("sends running and terminal operation cards in order", async () => {
    const markdownCards: string[] = [];
    const updates: string[] = [];
    const outbox = new FeishuOutbox(
      "cli_app",
      {
        ...cardMethods,
        createStreamingCard: async (_chatId, markdown) => ({ cardId: `card:${markdown}`, messageId: "om_stream" }),
        updateStreamingCard: async (_cardId, markdown) => { updates.push(markdown); },
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
    expect(markdownCards[0]).toContain("**运行命令 · 已完成**");
    expect(markdownCards[0]).toContain("git status --short");
    expect(markdownCards[1]).toBe(turnCompletedMarkdown);
    expect(updates).toEqual([]);
  });

  it("deduplicates repeated identical operation states", async () => {
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
    outbox.handle(operationUpdated("running"));
    await outbox.close();

    expect(markdownCards).toHaveLength(0);
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

});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
