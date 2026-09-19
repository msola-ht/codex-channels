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
const turnCompletedText = "**本次运行 · 已完成**\n\n**当前会话**\n- Session：测试会话\n- Session ID：thread";
const turnStoppedText = "**本次运行 · 已停止**\n\n**当前会话**\n- Session：测试会话\n- Session ID：thread";

describe("WeixinOutbox", () => {
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

  it("delivers idle release with the exact resume command", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "conversation.idle.released",
      target,
      threadId: "thread-idle-123",
      minutes: 15,
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0].text).toContain("thread-idle-123");
    expect(sendText.mock.calls[0]?.[0].text).toContain("/r thread-idle-123");
  });

  it("delivers the global idle notice while ignoring ordinary warnings", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle({
      type: "warning",
      target,
      message: "所有模型连接已空闲，空闲的 App Server 即将停止。",
      globalIdle: true,
    });
    outbox.handle({
      type: "warning",
      target,
      message: "普通警告不应发送。",
    });
    await outbox.close();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0].text).toContain(
      "所有模型连接已空闲，空闲的 App Server 即将停止。",
    );
  });

  it("reserves the reply window for lifecycle output", async () => {
    const { outbox, sendImage, sendText } = outboxFixture(
      { value: true },
      {
        operationUpdateDisplay: "full",
        planUpdatesEnabled: true,
        reasoningEnabled: true,
      },
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
    outbox.handle(planUpdated([
      { step: "检查实现", status: "inProgress" },
    ]));
    outbox.handle(operationUpdated("failed"));
    outbox.handle(imageGenerationCompleted("/private/generated/image.png"));
    outbox.handle({
      type: "connection.restored",
      target,
      threadId: "thread",
      message: "连接已恢复",
    });
    outbox.handle({
      type: "account.updated",
      target,
      authMode: "chatgpt",
      planType: "pro",
    });
    outbox.handle({
      type: "user.message",
      target,
      threadId: "thread",
      turnId: "turn",
      itemId: "external-input",
      text: "来自 CLI 的输入",
    });
    outbox.handle({
      type: "subagent.spawned",
      target,
      threadId: "thread",
      turnId: "turn",
      agentThreadId: "agent-thread",
      agentPath: "/root/review",
    });
    await outbox.close();

    expect(sendText).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
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
        + "- 错误：受控错误\n\n"
        + "**当前会话**\n"
        + "- Session：测试会话\n"
        + "- Session ID：thread",
    ]);
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

  it("does not retry a rejected context with a long-answer text fallback", async () => {
    const longText = "测".repeat(20_001);
    const fixture = outboxFixture(
      { value: true },
      {},
      async () => {},
      async () => {},
      async () => {
        throw new WeixinProtocolError(
          "api-error",
          "private upstream response",
          undefined,
          -2,
        );
      },
    );

    fixture.outbox.handle(completed("final_answer", longText));
    await fixture.outbox.close();

    expect(fixture.sendText).toHaveBeenCalledOnce();
    expect(fixture.sendFile).toHaveBeenCalledOnce();
    expect(fixture.contexts.get(target)).toBeUndefined();
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

  it("rechecks authorization and tolerates a missing reply context", async () => {
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
    expect(onReplyContextInvalidated).toHaveBeenCalledWith(
      target,
      "context-secret",
    );
    expect(sendText).not.toHaveBeenCalled();

    allowed.value = true;
    await expect(outbox.deliverText(target, "missing")).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledWith({
      actorId,
      text: "missing",
    }, expect.any(AbortSignal));
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
    expect(onReplyContextInvalidated).toHaveBeenCalledWith(
      target,
      "context-secret",
    );
    await outbox.close();
  });

  it("does not invalidate a newer context when an older queued send is rejected", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(
      async ({ text, contextToken }) => {
        if (text === "first") {
          await firstGate;
          return;
        }
        if (contextToken === "context-secret") {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -2,
          );
        }
      },
    );
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "context-secret");
    const onReplyContextInvalidated = vi.fn(async () => {});
    const outbox = new WeixinOutbox(
      accountId,
      { sendText },
      contexts,
      accessFixture(true),
      pino({ level: "silent" }),
      { onReplyContextInvalidated },
    );

    expect(outbox.notifyText(target, "first")).toBe(true);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledOnce());
    expect(outbox.notifyText(target, "old queued")).toBe(true);
    contexts.remember(target, actorId, "new-context");
    releaseFirst();

    await vi.waitFor(() => {
      expect(sendText.mock.calls.map(([input]) => input.text)).toContain(
        "old queued",
      );
    });
    expect(contexts.get(target)).toEqual({
      actorId,
      contextToken: "new-context",
    });
    expect(onReplyContextInvalidated).not.toHaveBeenCalled();

    expect(outbox.notifyText(target, "new output")).toBe(true);
    await outbox.close();
    expect(sendText.mock.calls.at(-1)?.[0]).toMatchObject({
      contextToken: "new-context",
      text: "new output",
    });
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
