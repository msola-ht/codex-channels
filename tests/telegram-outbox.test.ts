import type { Api } from "grammy";
import type { InputRichMessage } from "grammy/types";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/events.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";

const target = { surface: "telegram" as const, conversationId: "100" };

class FakeTelegramApi {
  readonly actions: string[] = [];
  readonly sent: string[] = [];
  readonly sendOptions: unknown[] = [];
  readonly edits: string[] = [];
  readonly editOptions: unknown[] = [];
  readonly richMessages: InputRichMessage[] = [];
  readonly richEdits: InputRichMessage[] = [];
  rejectRichMessages = false;
  rejectHtmlMessages = false;
  private nextMessageId = 1;

  async sendChatAction(_chatId: string, action: string): Promise<true> {
    this.actions.push(action);
    return true;
  }

  async sendMessage(_chatId: string, text: string, options?: unknown): Promise<{ message_id: number }> {
    if (this.rejectHtmlMessages && hasHtmlParseMode(options)) {
      throw new Error("Bad Request: can't parse entities");
    }
    this.sent.push(text);
    this.sendOptions.push(options);
    return { message_id: this.nextMessageId++ };
  }

  async sendRichMessage(
    _chatId: string,
    richMessage: InputRichMessage,
    options?: unknown,
  ): Promise<{ message_id: number }> {
    this.richMessages.push(richMessage);
    if (this.rejectRichMessages) {
      throw new Error("Bad Request: can't parse rich message");
    }
    this.sent.push(richMessage.markdown ?? richMessage.html ?? "[rich blocks]");
    this.sendOptions.push(options);
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(
    _chatId: string,
    _messageId: number,
    text: string | InputRichMessage,
    options?: unknown,
  ): Promise<true> {
    if (typeof text === "string") {
      if (this.rejectHtmlMessages && hasHtmlParseMode(options)) {
        throw new Error("Bad Request: can't parse entities");
      }
      this.edits.push(text);
    } else {
      this.richEdits.push(text);
      if (this.rejectRichMessages) {
        throw new Error("Bad Request: can't parse rich message");
      }
      this.edits.push(text.markdown ?? text.html ?? "[rich blocks]");
    }
    this.editOptions.push(options);
    return true;
  }

}

afterEach(() => {
  vi.useRealTimers();
});

describe("TelegramOutbox", () => {
  it("keeps Telegram typing active while a turn is running and stops on completion", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    const stopRequestTyping = outbox.beginTyping(target.conversationId);
    outbox.handle(turnStarted());
    stopRequestTyping();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(api.actions).toEqual(["typing"]);

    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(api.actions).toEqual(["typing", "typing"]);

    outbox.handle(turnCompleted());
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();
    expect(api.actions).toEqual(["typing", "typing"]);

    await outbox.close();
  });

  it("stops typing and reports a failed turn after finalizing streamed text", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.handle(textCompleted("commentary", "执行到一半。"));
    outbox.handle({
      ...turnCompleted(),
      status: "failed",
      error: "命令执行失败",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.sent).toEqual(["执行到一半。", "Codex 任务失败：命令执行失败"]);
    expect(api.actions).toEqual([]);

    await outbox.close();
  });

  it("renders each agent message item from one turn as a separate Telegram message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    outbox.setTurnReplyTarget("thread-1", "turn-1", 42);
    outbox.handle(textDelta("commentary", "正在检查", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle(textCompleted("commentary", "正在检查。", "commentary"));
    outbox.handle(textDelta("final", "检查完成。", "final_answer"));
    outbox.handle(textCompleted("final", "检查完成。", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["正在检查", "检查完成。"]);
    expect(api.edits).toContain("正在检查。");
    expect(api.sendOptions[0]).toEqual({});
    expect(api.sendOptions[1]).toMatchObject({
      reply_parameters: { message_id: 42 },
    });
    expect(api.richMessages).toEqual([]);
    expect(api.sendOptions[1]).toMatchObject({ parse_mode: "HTML" });
  });

  it("renders final answers as compatible Telegram HTML by default", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const markdown = [
      "# 服务职责",
      "",
      "- App Server",
      "- Gateway",
      "",
      "```text",
      "App Server -> Gateway -> Telegram",
      "```",
    ].join("\n");

    outbox.handle(textCompleted("final", markdown, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.richMessages).toEqual([]);
    expect(api.sent).toEqual([
      "<b>服务职责</b>\n\n• App Server\n• Gateway\n\n" +
      "<pre><code class=\"language-text\">App Server -&gt; Gateway -&gt; Telegram</code></pre>",
    ]);
    expect(api.sendOptions).toEqual([{ parse_mode: "HTML" }]);
  });

  it("keeps native Telegram Rich Markdown as an opt-in format", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api, "rich");
    const markdown = "# 标题\n\n- Rich Message";

    outbox.handle(textCompleted("final", markdown, "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.richMessages).toEqual([{ markdown }]);
    expect(api.sent).toEqual([markdown]);
  });

  it("upgrades a streamed final answer to Rich Markdown when completed", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api, "rich");

    outbox.handle(textDelta("final", "# 标题", "final_answer"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    outbox.handle(textCompleted("final", "# 标题\n\n最终内容", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["# 标题"]);
    expect(api.richEdits).toEqual([{ markdown: "# 标题\n\n最终内容" }]);
    expect(api.edits).toContain("# 标题\n\n最终内容");
  });

  it("falls back to plain text when Telegram rejects a Rich Message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    api.rejectRichMessages = true;
    const outbox = createOutbox(api, "rich");

    outbox.handle(textCompleted("final", "# 无法解析的内容", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.richMessages).toEqual([{ markdown: "# 无法解析的内容" }]);
    expect(api.sent).toEqual(["# 无法解析的内容"]);
  });

  it("falls back to plain text when Telegram rejects compatible HTML", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    api.rejectHtmlMessages = true;
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "# 无法解析的内容", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["# 无法解析的内容"]);
    expect(api.sendOptions).toEqual([{}]);
  });

  it("renders external user input before the mirrored reply", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle({
      type: "user.message",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      text: "从 CLI 发来的输入\n第二行",
    });
    outbox.handle(textCompleted("final", "同步回复"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "<b>CLI 输入</b>\n\n<blockquote>从 CLI 发来的输入\n第二行</blockquote>",
      "同步回复",
    ]);
    expect(api.sendOptions[0]).toEqual({ parse_mode: "HTML" });
    expect(api.sendOptions[1]).toMatchObject({
      reply_parameters: {
        message_id: 1,
        allow_sending_without_reply: true,
      },
    });
  });

  it("coalesces one turn's operation updates into one editable message", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.setTurnReplyTarget("thread-1", "turn-1", 42);
    outbox.handle(operationUpdated("command-1", "running", "command", "TOKEN=[REDACTED] git status --short"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toEqual([
      "<b>操作过程</b>\n\n💻 ⏳ <b>运行命令</b>\n" +
      "<pre><code class=\"language-shell\">TOKEN=[已隐藏] git status --short</code></pre>",
    ]);
    expect(api.sendOptions[0]).toMatchObject({
      parse_mode: "HTML",
      reply_parameters: { message_id: 42 },
    });

    outbox.handle({
      ...operationUpdated("command-1", "completed", "command", "TOKEN=[REDACTED] git status --short"),
      operation: {
        ...operationUpdated("command-1", "completed", "command", "TOKEN=[REDACTED] git status --short").operation,
        durationMs: 125,
        exitCode: 0,
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.edits.at(-1)).toContain("💻 <b>运行命令</b>");
    expect(api.edits.at(-1)).not.toMatch(/退出码|毫秒|秒/);
    expect(api.editOptions.at(-1)).toEqual({ parse_mode: "HTML" });

    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "README.md"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(1);
    expect(api.edits.at(-1)).toContain("🔧 <b>修改文件</b>\n<blockquote>README.md</blockquote>");
  });

  it("groups identical consecutive operations and escapes Telegram HTML", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "src/a<b>.ts & README.md"));
    outbox.handle(operationUpdated("file-2", "completed", "fileChange", "src/a<b>.ts & README.md"));
    outbox.handle(operationUpdated("tool-1", "completed", "dynamicTool", "browser.open"));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent[0]).toContain(
      "🔧 <b>修改文件 (×2)</b>\n<blockquote>src/a&lt;b&gt;.ts &amp; README.md</blockquote>",
    );
    expect(api.sent[0]).toContain(
      "🧰 <b>调用工具</b>\n<blockquote>browser.open</blockquote>",
    );

    await outbox.close();
  });

  it("segments operations around agent replies in chronological order", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(operationUpdated("command-1", "completed", "command", "git status --short"));
    outbox.handle(textCompleted("commentary", "第一段回复", "commentary"));
    outbox.handle(operationUpdated("file-1", "completed", "fileChange", "README.md"));
    outbox.handle(textCompleted("final", "第二段回复", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toHaveLength(4);
    expect(api.sent[0]).toContain("💻 <b>运行命令</b>");
    expect(api.sent[1]).toBe("第一段回复");
    expect(api.sent[2]).toContain("🔧 <b>修改文件</b>");
    expect(api.sent[3]).toBe("第二段回复");
  });

  it("flushes pending replies before an ordered interaction", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("commentary", "批准前说明", "commentary"));
    outbox.prepareInteraction(target.conversationId, userInputInteraction());
    const sent = outbox.runOrdered(target.conversationId, async () => {
      api.sent.push("审批卡片");
      return 7;
    });
    await settle();

    await expect(sent).resolves.toBe(7);
    expect(api.sent).toEqual(["批准前说明", "审批卡片"]);

    await outbox.close();
  });

  it("shows an approval-gated command only after approval", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    outbox.prepareInteraction(target.conversationId, request);
    const card = outbox.runOrdered(target.conversationId, async () => {
      api.sent.push("审批卡片");
      return true;
    });
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    await expect(card).resolves.toBe(true);
    expect(api.sent).toEqual(["审批卡片"]);

    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: true,
    });
    await settle();

    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]).toContain("运行命令");
    await outbox.close();
  });

  it("does not show an approval-gated command after rejection", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    outbox.prepareInteraction(target.conversationId, request);
    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: false,
    });
    outbox.handle(operationUpdated("command-1", "declined", "command", "npm install -g ."));
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toEqual([]);
    await outbox.close();
  });

  it("keeps a command hidden when its item starts after the approval card", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);
    const request = commandApprovalInteraction();

    outbox.prepareInteraction(target.conversationId, request);
    outbox.handle(operationUpdated("command-1", "running", "command", "npm install -g ."));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(api.sent).toEqual([]);
    outbox.finishInteraction(target.conversationId, request, {
      type: "approval",
      approved: true,
    });
    await settle();
    expect(api.sent[0]).toContain("运行命令");

    await outbox.close();
  });

  it("bounds long operation histories and keeps the most recent records", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    for (let index = 0; index < 101; index += 1) {
      outbox.handle(operationUpdated(
        `command-${index}`,
        index === 100 ? "failed" : "completed",
        "command",
        `命令 ${index}`,
      ));
    }
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toContain("已省略较早的 81 项操作");
    expect(api.sent[0]).not.toContain("命令 0\n");
    expect(api.sent[0]).toContain(
      "💻 ❌ <b>运行命令</b>\n<pre><code class=\"language-shell\">命令 100</code></pre>",
    );

    await outbox.close();
  });

  it("replies to the Telegram message that started the turn", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.setTurnReplyTarget("thread-1", "turn-1", 42);
    outbox.handle(textCompleted("final-1", "来自 Codex 的回复", "final_answer"));
    outbox.handle(textCompleted("final-2", "补充说明", "final_answer"));
    outbox.handle(turnCompleted());
    await settle();
    await outbox.close();

    expect(api.sent).toEqual(["来自 Codex 的回复", "补充说明"]);
    expect(api.sendOptions[0]).toMatchObject({
      reply_parameters: {
        message_id: 42,
        allow_sending_without_reply: true,
      },
    });
    expect(api.sendOptions[1]).toEqual({ parse_mode: "HTML" });
  });

  it("reports current context usage after the turn's final reply", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "处理完成", "final_answer"));
    outbox.handle({
      ...turnCompleted(),
      tokenUsage: {
        total: tokenBreakdown(80_000),
        last: tokenBreakdown(24_600),
        modelContextWindow: 258_000,
      },
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    await settle();
    await outbox.close();

    expect(api.sent).toEqual([
      "处理完成",
      [
        "<b>上下文：24.6 K / 258 K（9.5%）</b>",
        "<b>当前模型：</b>gpt-5.6-sol",
        "<b>思考强度：</b>medium",
      ].join("\n"),
    ]);
    expect(api.sendOptions[1]).toEqual({ parse_mode: "HTML" });
  });

  it("finalizes completed stream content during graceful shutdown", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textCompleted("final", "关闭前已经完成", "final_answer"));
    await outbox.close();

    expect(api.sent).toEqual(["关闭前已经完成"]);
  });

  it("does not persist an incomplete stream during graceful shutdown", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(textDelta("final", "仍在生成", "final_answer"));
    await outbox.close();

    expect(api.sent).toEqual([]);
  });

  it("clears pending typing and stream output after the App Server disconnects", async () => {
    vi.useFakeTimers();
    const api = new FakeTelegramApi();
    const outbox = createOutbox(api);

    outbox.handle(turnStarted());
    await vi.advanceTimersByTimeAsync(400);
    outbox.handle(textDelta("commentary", "尚未完成", "commentary"));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    outbox.handle({
      type: "connection.lost",
      target,
      threadId: "thread-1",
      message: "连接已断开",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();

    expect(api.actions).toEqual(["typing"]);
    expect(api.sent).toEqual(["尚未完成", "Codex 警告：连接已断开"]);

    await outbox.close();
  });
});

function createOutbox(
  api: FakeTelegramApi,
  finalMessageFormat: "html" | "rich" = "html",
): TelegramOutbox {
  return new TelegramOutbox(
    api as unknown as Api,
    pino({ level: "silent" }),
    undefined,
    { finalMessageFormat },
  );
}

function turnStarted(): Extract<OutputEvent, { type: "turn.started" }> {
  return { type: "turn.started", target, threadId: "thread-1", turnId: "turn-1" };
}

function turnCompleted(): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
  };
}

function textDelta(
  itemId: string,
  text: string,
  phase?: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.delta" }> {
  return {
    type: "text.delta",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
    ...(phase ? { phase } : {}),
  };
}

function textCompleted(
  itemId: string,
  text: string,
  phase?: "commentary" | "final_answer",
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    text,
    ...(phase ? { phase } : {}),
  };
}

function operationUpdated(
  itemId: string,
  status: "running" | "completed" | "failed" | "declined",
  kind: Extract<OutputEvent, { type: "operation.updated" }>["operation"]["kind"],
  detail?: string,
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread-1",
    turnId: "turn-1",
    operation: {
      itemId,
      status,
      kind,
      ...(detail ? { detail } : {}),
    },
  };
}

function commandApprovalInteraction() {
  return {
    type: "approval" as const,
    requestId: "request-1",
    kind: "command" as const,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "command-1",
    title: "Codex 请求执行命令",
    detail: "npm install -g .",
    expiresInMs: 30_000,
  };
}

function userInputInteraction() {
  return {
    type: "user-input" as const,
    requestId: "request-input",
    title: "Codex 需要输入",
    questions: [],
    expiresInMs: 30_000,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function tokenBreakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens - 500,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 100,
  };
}

function hasHtmlParseMode(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    "parse_mode" in value &&
    value.parse_mode === "HTML";
}
