import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuOutbox,
} from "../src/surfaces/feishu/index.js";
import { toConversationInputEvent } from "../src/codex-client/index.js";
import { completed, operationUpdated, turnCompleted } from "./support/feishu-outbox-fixtures.js";


const turnCompletedMarkdown = "## 本次运行 · 已完成\n\n### 当前会话\n- Session：测试会话\n- Session ID：thread-1";

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
  it.each([
    ["compact", "completed", "已完成"],
    ["compact", "failed", "失败"],
    ["full", "completed", "已完成"],
    ["full", "failed", "失败"],
    ["hidden", "completed", "已完成"],
    ["hidden", "failed", "失败"],
  ] as const)(
    "updates one CUA card before the final reply in %s mode: %s", async (display, status, label) => {
      const sent: string[] = [];
      const updates: string[] = [];
      const markdownCards: string[] = [];
      const outbox = new FeishuOutbox("cli_app", {
        ...cardMethods, sendText: async () => {}, sendPost: async () => {},
        sendCard: async (_chatId, card) => { sent.push(JSON.stringify(card)); return "om_cua"; },
        updateCard: async (messageId, card) => {
          expect(messageId).toBe("om_cua");
          updates.push(JSON.stringify(card));
        },
        sendMarkdownCard: async (_chatId, markdown) => { markdownCards.push(markdown); },
      }, pino({ level: "silent" }), { operationUpdateDisplay: display });
      for (const phase of ["started", "completed"] as const) {
        const input = toConversationInputEvent({
          method: `item/${phase}`,
          params: {
            threadId: "thread-1", turnId: "turn-1",
            item: {
              type: "mcpToolCall", id: "cua-1", server: "cua_repl", tool: "js",
              status: phase === "started" ? "inProgress" : status,
              readOnlyHint: true,
              arguments: { title: "检查 Chrome 标签页", code: "private-code" },
            },
          },
        });
        if (input?.type !== "item.operation.updated") throw new Error("Missing operation");
        const output = { ...operationUpdated("running"), operation: input.operation };
        outbox.handle(output);
        outbox.handle(output);
        await settle();
        expect(sent).toHaveLength(display === "hidden" ? 0 : 1);
        expect(updates).toHaveLength(display === "hidden" || phase === "started" ? 0 : 1);
        expect(markdownCards).toEqual([]);
      }
      outbox.handle(completed({}, "最终回复"));
      await outbox.close();
      expect(markdownCards).toEqual(["最终回复"]);
      if (display !== "hidden") {
        expect(sent[0]).toContain("电脑与浏览器操作 · 运行中");
        expect(updates[0]).toContain(`电脑与浏览器操作 · ${label}`);
        expect([...sent, ...updates].every((card) => card.includes("检查 Chrome 标签页"))).toBe(true);
        expect([...sent, ...updates].join("\n")).not.toMatch(/private-code|上游标记只读/);
      }
    },
  );

  it("keeps queued CUA updates attached to their own item and turn while creation is pending", async () => {
    const calls: string[] = [];
    let release!: (messageId: string) => void;
    const firstMessage = new Promise<string>((resolve) => { release = resolve; });
    let creates = 0;
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {}, sendPost: async () => {},
      sendCard: async (_chatId, card) => {
        if (card.header.title.content === "Session 状态") return "om_status";
        creates += 1;
        calls.push(`create:${creates}:${card.header.title.content}`);
        return creates === 1 ? firstMessage : `om_cua_${creates}`;
      },
      updateCard: async (messageId, card) => { calls.push(`update:${messageId}:${card.header.title.content}`); },
    }, pino({ level: "silent" }));
    outbox.handle(computerUseEvent("running"));
    await settle();
    outbox.handle(computerUseEvent("completed"));
    outbox.handle(turnCompleted());
    outbox.handle({ type: "turn.started", target: operationUpdated("running").target, threadId: "thread-1", turnId: "turn-2" });
    outbox.handle({ ...computerUseEvent("running"), turnId: "turn-2" });
    outbox.handle({ ...computerUseEvent("completed"), turnId: "turn-2" });
    release("om_cua_1");
    await outbox.close();
    expect(calls.filter((call) => call.includes("电脑与浏览器操作"))).toEqual([
      "create:1:电脑与浏览器操作 · 运行中",
      "update:om_cua_1:电脑与浏览器操作 · 已完成",
      "create:2:电脑与浏览器操作 · 运行中",
      "update:om_cua_2:电脑与浏览器操作 · 已完成",
    ]);
  });

  it.each([false, true])("sends a terminal CUA card when no running card was delivered (creation failed: %s)", async (failedStart) => {
    const sendCard = vi.fn(async () => "om_cua");
    if (failedStart) sendCard.mockRejectedValueOnce(new Error("send failed"));
    const updateCard = vi.fn(async () => {});
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {}, sendPost: async () => {}, sendCard, updateCard,
    }, pino({ level: "silent" }));
    if (failedStart) outbox.handle(computerUseEvent("running"));
    outbox.handle(computerUseEvent("completed"));
    await outbox.close();
    expect(sendCard).toHaveBeenCalledTimes(failedStart ? 2 : 1);
    expect(sendCard).toHaveBeenLastCalledWith("oc_chat", expect.objectContaining({
      header: expect.objectContaining({ title: { tag: "plain_text", content: "电脑与浏览器操作 · 已完成" } }),
    }), expect.any(AbortSignal));
    expect(updateCard).not.toHaveBeenCalled();
  });

  it("preserves the terminal result when the existing CUA card cannot be updated", async () => {
    const sendCard = vi.fn(async () => "om_cua");
    const updateCard = vi.fn(async () => { throw new Error("patch failed"); });
    const markdownCards: string[] = [];
    const logger = pino({ level: "silent" });
    const warning = vi.spyOn(logger, "warn");
    const outbox = new FeishuOutbox("cli_app", {
      ...cardMethods, sendText: async () => {}, sendPost: async () => {}, sendCard, updateCard,
      sendMarkdownCard: async (_chatId, markdown) => { markdownCards.push(markdown); },
    }, logger);
    outbox.handle(computerUseEvent("running"));
    outbox.handle(computerUseEvent("completed"));
    outbox.handle(completed({}, "最终回复"));
    await outbox.close();
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(markdownCards).toHaveLength(2);
    expect(markdownCards[0]).toContain("电脑与浏览器操作 · 已完成");
    expect(markdownCards[0]).toContain("125 ms");
    expect(markdownCards[1]).toBe("最终回复");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ fallback: "markdown" }), expect.any(String));
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
      + "**耗时：** 125 ms",
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
      + "**耗时：** 125 ms",
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
      + "---\n**耗时：** 375 ms",
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

function computerUseEvent(status: "running" | "completed"): ReturnType<typeof operationUpdated> {
  const event = operationUpdated(status, "mcpTool", "cua-1", "检查 Chrome 标签页 · cua_repl.js");
  return { ...event, operation: { ...event.operation, action: "computerUse", readOnlyHint: true } };
}
