import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  OutputEvent,
} from "../src/conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../src/policy/index.js";
import {
  WeixinOutbox,
  WeixinProtocolError,
  WeixinReplyContextStore,
  type WeixinFileSendProtocolClient,
  type WeixinImageSendProtocolClient,
  type WeixinOutboxOptions,
  type WeixinProtocolClient,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
} as const;
const turnCompletedText = "**本次运行 · 已完成**\n\n- Session：测试会话\n- Session ID：thread";
const turnStoppedText = "**本次运行 · 已停止**\n\n- Session：测试会话\n- Session ID：thread";

describe("WeixinOutbox", () => {
  it("shows one initial plan and one message for each completed step", async () => {
    const { outbox, sendText } = outboxFixture(
      { value: true },
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
    await outbox.close();

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[0]?.[0].text).toContain("任务计划 · 0/2");
    expect(sendText.mock.calls[1]?.[0].text).toContain("计划进度 · 1/2");
    expect(sendText.mock.calls[1]?.[0].text).toContain(
      "第 1 步完成：检查实现",
    );
  });

  it("keeps reply contexts private to one account and Conversation", () => {
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");

    const first = contexts.get(target);
    expect(first).toEqual({ actorId, contextToken: "context-secret" });
    expect(contexts.get(target)).not.toBe(first);
    expect(() => contexts.remember(
      target,
      "other-fixture@im.wechat",
      "other-context",
    )).toThrow("微信回复上下文无效");
    expect(() => contexts.get({
      ...target,
      accountId: "other@im.bot",
    })).toThrow("微信回复目标无效");
  });

  it("acknowledges Turn start and sends final text and completion", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(turnStarted());
    outbox.handle(completed("commentary", "working"));
    outbox.handle({
      ...completed("final_answer", "foreign"),
      target: { ...target, accountId: "other@im.bot" },
    });
    outbox.handle(completed("final_answer", "final reply"));
    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "已开始处理。",
      "final reply",
      turnCompletedText,
    ]);
  });

  it("shows the thinking status with elapsed time", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread",
      turnId: "turn",
      summary: "",
      elapsedMs: 0,
    });
    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread",
      turnId: "turn",
      summary: "",
      elapsedMs: 3_000,
    });
    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread",
      turnId: "turn",
      summary: "",
      elapsedMs: 15_000,
      final: true,
    });
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "思考中…\n\n耗时：15秒",
    ]);
  });

  it("does not send thinking status when reasoning display is disabled", async () => {
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { reasoningEnabled: false },
    );

    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread",
      turnId: "turn",
      summary: "",
      elapsedMs: 15_000,
      final: true,
    });
    await outbox.close();

    expect(sendText).not.toHaveBeenCalled();
  });

  it("drops queued final reasoning after command execution starts", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let sendCount = 0;
    const { outbox, sendText } = outboxFixture(
      { value: true },
      {},
      async () => {
        sendCount += 1;
        if (sendCount === 1) {
          await startGate;
        }
      },
    );

    outbox.handle(turnStarted());
    outbox.handle({
      type: "turn.reasoning",
      target,
      threadId: "thread",
      turnId: "turn",
      summary: "",
      elapsedMs: 15_000,
      final: true,
    });
    outbox.handle(operationUpdated("running"));
    releaseStart();
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "已开始处理。",
    ]);
  });

  it("sends a connection restore notice", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "connection.restored",
      target,
      threadId: "thread",
      message: "openai App Server 已重新连接",
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Codex 连接已恢复：openai App Server 已重新连接",
      }),
    );
  });

  it("asks for and renders the OpenCode Go remaining usage on completion", async () => {
    const requestStartedAtMs = Date.parse("2026-08-17T03:30:00.000Z");
    const remainingUsage = vi.fn<NonNullable<WeixinOutboxOptions["remainingUsage"]>>(async () => ({
      model: "deepseek-v4-flash",
      bucket: "peak",
      includedUsageUsd: 15,
      usedUsdNanos: 2_813_173_642,
      usedPercent: 2_813_173_642 / 15_000_000_000 * 100,
      remainingUsdNanos: 12_186_826_358,
      windowStartAtMs: 1_786_803_727_000,
      windowEndAtMs: 1_789_482_127_000,
    }));
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { remainingUsage },
    );

    await outbox.handle({
      type: "turn.completed",
      target,
      threadId: "thread",
      turnId: "turn",
      status: "completed",
      model: "deepseek-v4-flash",
      modelProvider: "opencode-go",
      effort: "high",
      serviceTier: null,
      timing: { modelRequestCount: 1, modelRequestStartedAtMs: requestStartedAtMs },
    });
    await outbox.close();

    expect(remainingUsage).toHaveBeenCalledWith(
      "deepseek-v4-flash",
      requestStartedAtMs,
      "opencode-go",
    );
    const text = sendText.mock.calls.at(-1)?.[0].text ?? "";
    expect(text).toContain("**账户状态**");
    expect(text).toContain("剩余用量（Peak）：剩余 $12.19 · 包含 $15.00 · 已用 18.8%");
  });

  it("does not ask for remaining usage on non-OpenCode Go completions", async () => {
    const remainingUsage = vi.fn<NonNullable<WeixinOutboxOptions["remainingUsage"]>>(
      async () => null,
    );
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { remainingUsage },
    );

    await outbox.handle({
      type: "turn.completed",
      target,
      threadId: "thread",
      turnId: "turn",
      status: "completed",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: null,
    });
    await outbox.close();

    expect(remainingUsage).toHaveBeenCalledWith(
      "deepseek-v4-flash",
      undefined,
      "deepseek",
    );
    const text = sendText.mock.calls.at(-1)?.[0].text ?? "";
    expect(text).not.toContain("账户状态");
    expect(text).not.toContain("剩余用量");
  });

  it("identifies the Plugin in the unified Turn start reply", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      ...turnStarted(),
      identity: { kind: "plugin", name: "GitHub" },
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "已使用 GitHub Plugin 开始处理。",
    }));
  });

  it("mirrors CLI input into the bound Weixin conversation", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "user.message",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "external-input",
      text: "从 CLI 发来的输入\n第二行",
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: "CLI 输入\n\n从 CLI 发来的输入\n第二行",
    });
  });

  it("starts typing and cancels it before the final reply", async () => {
    const events: string[] = [];
    const typing = {
      start: vi.fn(() => {
        events.push("typing:start");
      }),
      stop: vi.fn(async () => {
        events.push("typing:stop");
      }),
      close: vi.fn(async () => {
        events.push("typing:close");
      }),
    };
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { typing },
      async () => {
        events.push("text:send");
      },
    );

    outbox.handle(turnStarted());
    outbox.handle(completed("final_answer", "final reply"));
    await outbox.close();

    expect(typing.start).toHaveBeenCalledWith(target);
    expect(typing.stop).toHaveBeenCalledWith(target);
    expect(events.filter((event) => event === "text:send")).toHaveLength(2);
    expect(events.indexOf("typing:start")).toBeLessThan(
      events.indexOf("text:send"),
    );
    expect(events.indexOf("typing:stop")).toBeLessThan(
      events.lastIndexOf("text:send"),
    );
    expect(typing.close).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "final reply",
    }));
  });

  it("compacts single-line fenced code in final answers", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(completed("final_answer", [
      "发送：",
      "```text",
      "/whoami",
      "```",
      "",
      "保留多行：",
      "```ts",
      "const first = 1;",
      "const second = 2;",
      "```",
    ].join("\n")));
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: [
        "发送：",
        "`/whoami`",
        "",
        "保留多行：",
        "```ts",
        "const first = 1;",
        "const second = 2;",
        "```",
      ].join("\n"),
    });
  });

  it("normalizes supported Markdown for Weixin final answers", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(completed("final_answer", [
      "##### 发布结果",
      "###### 兼容说明",
      "",
      "中文 *斜体* 与 _强调_。",
      "标识符 foo_中文_bar 保持原样。",
      "English *italic* and **bold**.",
      "[项目文档](https://example.com/docs)",
      "移除图片：![架构图](https://example.com/diagram.png)",
      "",
      "> **引用**",
      "- 列表",
      "~~删除线~~",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n")));
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: [
        "**发布结果**",
        "**兼容说明**",
        "",
        "中文 斜体 与 强调。",
        "标识符 foo_中文_bar 保持原样。",
        "English *italic* and **bold**.",
        "[项目文档](https://example.com/docs)",
        "移除图片：",
        "",
        "> **引用**",
        "- 列表",
        "~~删除线~~",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    });
  });

  it("leaves Markdown inside code intact and degrades an unclosed fence", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(completed("final_answer", [
      "```md",
      "##### code heading",
      "[code link](https://example.com/code)",
      "*中文代码*",
      "```",
      "",
      "未闭合代码：",
      "```ts",
      "const value = 1;",
    ].join("\n")));
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: [
        "```md",
        "##### code heading",
        "[code link](https://example.com/code)",
        "*中文代码*",
        "```",
        "",
        "未闭合代码：",
        "const value = 1;",
      ].join("\n"),
    });
  });

  it("renders terminal status when no final text was produced", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: turnCompletedText,
    });
  });

  it("renders stopped and failed Turn notifications", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(turnCompleted("interrupted"));
    outbox.handle({
      ...turnCompleted("failed"),
      error: "受控错误",
    });
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      turnStoppedText,
      "**本次运行 · 失败**\n\n"
        + "**本次运行**\n"
        + "- 错误：受控错误\n\n"
        + "**当前 Session 累计**\n"
        + "- Session：测试会话\n"
        + "- Session ID：thread",
    ]);
  });

  it("renders account, quota, and MCP status as ordered plain text", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "account.updated",
      target,
      authMode: "chatgpt",
      planType: "pro",
    });
    outbox.handle({
      type: "account.rateLimits.updated",
      target,
      rateLimits: {
        limitId: "codex",
        limitName: "周限",
        primary: {
          usedPercent: 12,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: false,
        planType: "pro",
        rateLimitReachedType: null,
      },
    });
    outbox.handle({
      type: "mcp.status.updated",
      target,
      threadId: "thread",
      name: "docs",
      status: "failed",
      error: "认证失败，TOKEN=[REDACTED]",
      failureReason: null,
    });
    outbox.handle({
      type: "mcp.oauth.completed",
      target,
      threadId: "thread",
      name: "docs",
      success: true,
      error: null,
    });
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "**Codex 账户状态已更新**\n- 认证：chatgpt\n- 套餐：Pro",
      "**周限 额度提醒**\n- 主窗口：已使用 12% · 周期 7 天\n- 状态：正常",
      "**MCP Server**\n- 名称：docs\n- 状态：启动失败\n- 原因：认证失败，TOKEN=[已隐藏]",
      "**MCP OAuth**\n- 名称：docs\n- 状态：登录成功",
    ]);
  });

  it("sends only terminal operation updates in Conversation order", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(operationUpdated("running"));
    outbox.handle(operationUpdated("completed"));
    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "运行命令 · 已完成 · exit 0\n\n"
      + "具体内容：\n\n"
      + "git status --short\n\n"
      + "耗时：125毫秒",
      turnCompletedText,
    ]);
  });

  it("sends a completed generated-image artifact before its operation summary", async () => {
    const events: string[] = [];
    const fixture = outboxFixture(
      { value: true },
      {
        readImage: vi.fn(async (path) => {
          events.push(`read:${path}`);
          return Buffer.from("validated-image");
        }),
      },
      async ({ text }) => {
        events.push(`text:${text}`);
      },
      async ({ image }) => {
        events.push(`image:${image.toString()}`);
      },
    );

    fixture.outbox.handle(imageGenerationCompleted(
      "/private/generated/image.png",
    ));
    await fixture.outbox.close();

    expect(fixture.sendImage).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      image: Buffer.from("validated-image"),
    });
    expect(events).toEqual([
      "read:/private/generated/image.png",
      "image:validated-image",
      "text:生成图片 · 已完成",
    ]);
  });

  it("sends generated images even when operation summaries are hidden", async () => {
    const fixture = outboxFixture(
      { value: true },
      { operationUpdateDisplay: "hidden" },
    );

    fixture.outbox.handle(imageGenerationCompleted(
      "/private/generated/image.png",
    ));
    fixture.outbox.handle({
      ...imageGenerationCompleted("/private/uploads/inbound.png"),
      operation: {
        ...imageGenerationCompleted("/private/uploads/inbound.png").operation,
        kind: "imageView",
      },
    });
    await fixture.outbox.close();

    expect(fixture.sendImage).toHaveBeenCalledOnce();
    expect(fixture.sendText).not.toHaveBeenCalled();
  });

  it("sends a channel image for an explicit target", async () => {
    const fixture = outboxFixture({ value: true });

    await fixture.outbox.sendChannelImage(
      target,
      "/private/generated/image.png",
    );
    await fixture.outbox.close();

    expect(fixture.sendImage).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      image: Buffer.from("validated-image"),
    }, expect.any(AbortSignal));
  });

  it("rechecks authorization after reading a generated image", async () => {
    const allowed = { value: true };
    const fixture = outboxFixture(
      allowed,
      {
        readImage: vi.fn(async () => {
          allowed.value = false;
          return Buffer.from("validated-image");
        }),
      },
    );

    fixture.outbox.handle(imageGenerationCompleted(
      "/private/generated/image.png",
    ));
    await fixture.outbox.close();

    expect(fixture.sendImage).not.toHaveBeenCalled();
    expect(fixture.contexts.get(target)).toBeUndefined();
    expect(fixture.onReplyContextInvalidated).toHaveBeenCalledWith(target);
  });

  it("hides operation updates without suppressing Turn completion", async () => {
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { operationUpdateDisplay: "hidden" },
    );

    outbox.handle(operationUpdated("running"));
    outbox.handle(operationUpdated("completed"));
    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      turnCompletedText,
    ]);
  });

  it("sends compact operation updates as one line", async () => {
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { operationUpdateDisplay: "compact" },
    );

    outbox.handle({
      ...operationUpdated("failed"),
      operation: {
        ...operationUpdated("failed").operation,
        detail: "first line\nsecond line",
        exitCode: 1,
      },
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: "运行命令 · 失败 · exit 1 · first line second line · 耗时：125毫秒",
    });
  });

  it("hides successful wait calls but keeps subagent failures in compact mode", async () => {
    const { outbox, sendText } = outboxFixture(
      { value: true },
      { operationUpdateDisplay: "compact" },
    );

    outbox.handle({
      ...operationUpdated("completed", "subagent", "wait-1"),
      operation: {
        ...operationUpdated("completed", "subagent", "wait-1").operation,
        action: "wait",
      },
    });
    outbox.handle({
      ...operationUpdated("failed", "subagent", "wait-2"),
      operation: {
        ...operationUpdated("failed", "subagent", "wait-2").operation,
        action: "wait",
      },
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0].text).toContain("等待子代理 · 失败");
  });

  it("sends one compact subagent start notice", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "subagent.spawned",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0].text).toBe("子代理开始 · review_task");
    expect(sendText.mock.calls[0]?.[0].text).not.toContain("agent-thread-secret");
  });

  it("sends one compact subagent follow-up notice", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "subagent.contacted",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0].text).toBe("子代理继续 · review_task");
    expect(sendText.mock.calls[0]?.[0].text).not.toContain("agent-thread-secret");
  });

  it("summarizes repeated query operations once before Turn completion", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(operationUpdated(
      "completed",
      "mcpTool",
      "mcp-1",
      "codex_apps.github.fetch_pr",
    ));
    outbox.handle(operationUpdated(
      "completed",
      "dynamicTool",
      "tool-1",
      "codex_apps.github.update_pull_request",
    ));
    expect(sendText).not.toHaveBeenCalled();

    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "工具查询 · 已完成\n\n"
      + "MCP 工具：1 次\n"
      + "  - codex＿apps.github.fetch＿pr · 读写属性未知：1 次\n"
      + "动态工具：1 次\n"
      + "  - codex＿apps.github.update＿pull＿request：1 次\n\n"
      + "总耗时：250毫秒",
      turnCompletedText,
    ]);
  });

  it("splits surrogate pairs and sends long final answers as a text file", async () => {
    const first = outboxFixture();
    const surrogateText = `${"a".repeat(3_999)}😀b`;
    first.outbox.handle(completed("final_answer", surrogateText));
    await first.outbox.close();

    const surrogateChunks = first.sendText.mock.calls.map(
      ([input]) => input.text,
    );
    expect(surrogateChunks).toHaveLength(2);
    expect(surrogateChunks[0]).toHaveLength(3_999);
    expect(surrogateChunks.join("")).toBe(surrogateText);

    const second = outboxFixture();
    const longText = "测".repeat(20_001);
    second.outbox.handle(completed(
      "final_answer",
      longText,
    ));
    await second.outbox.close();

    const previewChunks = second.sendText.mock.calls.map(
      ([input]) => input.text,
    );
    expect(previewChunks).toHaveLength(1);
    expect(previewChunks[0]).toHaveLength(4_000);
    expect(previewChunks[0]).toMatch(/\[内容预览\]$/u);
    expect(second.sendFile).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      fileName: "codex-final-answer.txt",
      file: Buffer.from(longText, "utf8"),
    });
  });

  it("keeps bounded text truncation when file sending is unavailable", async () => {
    const fixture = outboxFixture(
      { value: true },
      { includeFileClient: false },
    );
    fixture.outbox.handle(completed(
      "final_answer",
      "测".repeat(20_001),
    ));
    await fixture.outbox.close();

    const chunks = fixture.sendText.mock.calls.map(([input]) => input.text);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.join("")).toHaveLength(20_000);
    expect(chunks.at(-1)).toMatch(/\[内容过长，已截断\]$/u);
    expect(fixture.sendFile).not.toHaveBeenCalled();
  });

  it("falls back to remaining bounded text when the final-answer file fails", async () => {
    const longText = "测".repeat(20_001);
    const fixture = outboxFixture(
      { value: true },
      {},
      async () => {},
      async () => {},
      async () => {
        throw new WeixinProtocolError(
          "network-error",
          "private upload response",
        );
      },
    );

    fixture.outbox.handle(completed("final_answer", longText));
    await fixture.outbox.close();

    const chunks = fixture.sendText.mock.calls.map(([input]) => input.text);
    expect(fixture.sendFile).toHaveBeenCalledOnce();
    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks[0]).toMatch(/\[内容预览\]$/u);
    expect(chunks[1]).toMatch(
      /^\[文件发送失败，已改为分段文本\]\n\n/u,
    );
    expect(chunks.at(-1)).toMatch(/\[内容过长，已截断\]$/u);

    const previewText = chunks[0]!.replace(/\n\n\[内容预览\]$/u, "");
    const fallbackText = chunks.slice(1).join("")
      .replace(/^\[文件发送失败，已改为分段文本\]\n\n/u, "")
      .replace(/\n\n\[内容过长，已截断\]$/u, "");
    const deliveredText = previewText + fallbackText;
    expect(deliveredText).toBe(longText.slice(0, deliveredText.length));
  });

  it("keeps one Conversation ordered while allowing another to progress", async () => {
    const secondActorId = "second-fixture@im.wechat";
    const secondTarget = {
      ...target,
      conversationId: secondActorId,
    };
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-one");
    contexts.remember(secondTarget, secondActorId, "context-two");
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(
      async ({ actorId: recipient, text }) => {
        calls.push(`${recipient}:${text}:start`);
        if (recipient === actorId && text === "first") {
          await firstGate;
        }
        calls.push(`${recipient}:${text}:end`);
      },
    );
    const outbox = new WeixinOutbox(
      accountId,
      { sendText },
      contexts,
      accessFixture(true),
      pino({ level: "silent" }),
    );

    outbox.notifyText(target, "first");
    outbox.notifyText(target, "second");
    outbox.notifyText(secondTarget, "parallel");
    await vi.waitFor(() => {
      expect(calls).toContain(`${secondActorId}:parallel:end`);
    });
    expect(calls).not.toContain(`${actorId}:second:start`);

    releaseFirst();
    await outbox.close();
    expect(calls.indexOf(`${actorId}:first:end`)).toBeLessThan(
      calls.indexOf(`${actorId}:second:start`),
    );
  });

  it("retains critical output without interrupting in-flight delivery", async () => {
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: string[] = [];
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(
      async ({ text }) => {
        sent.push(text);
        if (text === "first") {
          await firstGate;
        }
      },
    );
    const outbox = new WeixinOutbox(
      accountId,
      { sendText },
      contexts,
      accessFixture(true),
      pino({ level: "silent" }),
      { capacity: 1 },
    );

    expect(outbox.notifyText(target, "first")).toBe(true);
    await vi.waitFor(() => {
      expect(sent).toEqual(["first"]);
    });
    expect(outbox.notifyText(target, "second")).toBe(true);
    expect(outbox.notifyText(target, "overloaded")).toBe(true);

    releaseFirst();
    await outbox.close();
    expect(sent).toEqual(["first", "second", "overloaded"]);
  });

  it("rechecks authorization and rejects missing or revoked reply contexts", async () => {
    const allowed = { value: true };
    const {
      outbox,
      contexts,
      sendText,
      onReplyContextInvalidated,
    } = outboxFixture(allowed);
    allowed.value = false;

    await expect(outbox.deliverText(target, "blocked"))
      .rejects.toMatchObject({ code: "unauthorized-recipient" });
    expect(contexts.get(target)).toBeUndefined();
    expect(onReplyContextInvalidated).toHaveBeenCalledWith(target);
    expect(sendText).not.toHaveBeenCalled();

    allowed.value = true;
    await expect(outbox.deliverText(target, "missing"))
      .rejects.toMatchObject({ code: "missing-reply-context" });
    await outbox.close();
  });

  it("invalidates only the failed Conversation when Weixin rejects its reply context", async () => {
    const {
      outbox,
      contexts,
      onReplyContextInvalidated,
    } = outboxFixture(
      { value: true },
      {},
      async () => {
        throw new WeixinProtocolError(
          "api-error",
          "private upstream response",
          undefined,
          -2,
        );
      },
    );
    const otherTarget = {
      ...target,
      conversationId: "other-fixture@im.wechat",
    };
    contexts.remember(
      otherTarget,
      "other-fixture@im.wechat",
      "other-context",
    );

    await expect(outbox.deliverText(target, "blocked"))
      .rejects.toMatchObject({ code: "api-error", returnCode: -2 });

    expect(contexts.get(target)).toBeUndefined();
    expect(contexts.get(otherTarget)).toEqual({
      actorId: "other-fixture@im.wechat",
      contextToken: "other-context",
    });
    expect(onReplyContextInvalidated).toHaveBeenCalledOnce();
    expect(onReplyContextInvalidated).toHaveBeenCalledWith(target);
    await outbox.close();
  });

  it("stops remaining chunks when authorization is revoked during delivery", async () => {
    const allowed = { value: true };
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {
      allowed.value = false;
    });
    const outbox = new WeixinOutbox(
      accountId,
      { sendText },
      contexts,
      accessFixture(() => allowed.value),
      pino({ level: "silent" }),
    );

    await expect(outbox.deliverText(target, "a".repeat(4_001)))
      .rejects.toMatchObject({ code: "unauthorized-recipient" });

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0]?.[0].text).toHaveLength(4_000);
    expect(contexts.get(target)).toBeUndefined();
    await outbox.close();
  });

  it("clears sensitive contexts and rejects new output after close", async () => {
    const { outbox, contexts, sendText } = outboxFixture();

    await outbox.close();
    await expect(outbox.close()).resolves.toBeUndefined();

    expect(contexts.get(target)).toBeUndefined();
    expect(outbox.notifyText(target, "late")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("logs constrained error metadata without response or context text", async () => {
    let logs = "";
    const destination = {
      write(message: string) {
        logs += message;
      },
    };
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");
    const outbox = new WeixinOutbox(
      accountId,
      {
        sendText: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private context-secret response",
            undefined,
            -14,
          );
        }),
      },
      contexts,
      accessFixture(true),
      pino({}, destination),
    );

    outbox.handle(completed("final_answer", "reply"));
    await outbox.close();

    expect(logs).toContain('"errorCode":"api-error"');
    expect(logs).toContain('"returnCode":-14');
    expect(logs).not.toContain("private");
    expect(logs).not.toContain("context-secret");
  });
});

function outboxFixture(
  allowed: { value: boolean } = { value: true },
  options: WeixinOutboxOptions & {
    includeFileClient?: boolean;
  } = {},
  sendTextImpl: WeixinProtocolClient["sendText"] = async () => {},
  sendImageImpl: WeixinImageSendProtocolClient["sendImage"] = async () => {},
  sendFileImpl: WeixinFileSendProtocolClient["sendFile"] = async () => {},
) {
  const contexts = new WeixinReplyContextStore(accountId);
  contexts.remember(target, actorId, "context-secret");
  const sendText = vi.fn<WeixinProtocolClient["sendText"]>(sendTextImpl);
  const sendImage = vi.fn<WeixinImageSendProtocolClient["sendImage"]>(
    sendImageImpl,
  );
  const sendFile = vi.fn<WeixinFileSendProtocolClient["sendFile"]>(
    sendFileImpl,
  );
  const onReplyContextInvalidated = vi.fn(async () => {});
  const {
    includeFileClient = true,
    ...outboxOptions
  } = options;
  return {
    contexts,
    sendText,
    sendImage,
    sendFile,
    onReplyContextInvalidated,
    outbox: new WeixinOutbox(
      accountId,
      { sendText },
      contexts,
      accessFixture(() => allowed.value),
      pino({ level: "silent" }),
      {
        ...(includeFileClient ? { fileClient: { sendFile } } : {}),
        imageClient: { sendImage },
        readImage: async () => Buffer.from("validated-image"),
        ...outboxOptions,
        onReplyContextInvalidated,
      },
    ),
  };
}

function imageGenerationCompleted(
  imagePath: string,
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    operation: {
      itemId: "generated-image",
      kind: "imageGeneration",
      status: "completed",
      imagePath,
    },
  };
}

function accessFixture(
  allowed: boolean | (() => boolean),
): SurfaceAccessPolicy {
  return {
    isAllowed: vi.fn(
      () => typeof allowed === "function" ? allowed() : allowed,
    ),
  };
}

function completed(
  phase: "commentary" | "final_answer",
  text: string,
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    phase,
    text,
  };
}

function turnStarted(): Extract<OutputEvent, { type: "turn.started" }> {
  return {
    type: "turn.started",
    target,
    threadId: "thread",
    turnId: "turn",
  };
}

function operationUpdated(
  status: "running" | "completed" | "failed" | "declined",
  kind: Extract<
    OutputEvent,
    { type: "operation.updated" }
  >["operation"]["kind"] = "command",
  itemId = "command",
  detail = "git status --short",
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    operation: {
      itemId,
      kind,
      detail,
      status,
      ...(status === "running"
        ? {}
        : { durationMs: 125, exitCode: 0 }),
    },
  };
}

function turnCompleted(
  status: "completed" | "interrupted" | "failed",
): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread",
    sessionName: "测试会话",
    turnId: "turn",
    status,
  };
}

function planUpdated(
  steps: Extract<OutputEvent, { type: "plan.updated" }>["steps"],
): Extract<OutputEvent, { type: "plan.updated" }> {
  return {
    type: "plan.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    explanation: null,
    steps,
  };
}
