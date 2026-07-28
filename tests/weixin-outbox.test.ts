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
      "本次运行 · 已完成",
    ]);
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

  it("renders terminal status when no final text was produced", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: "本次运行 · 已完成",
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
      "本次运行 · 已停止",
      "本次运行 · 失败\n\n错误：受控错误",
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
      "本次运行 · 已完成",
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
      "本次运行 · 已完成",
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

  it("summarizes repeated query operations once before Turn completion", async () => {
    const { outbox, sendText } = outboxFixture();

    outbox.handle(operationUpdated("completed", "mcpTool", "mcp-1"));
    outbox.handle(operationUpdated("completed", "dynamicTool", "tool-1"));
    expect(sendText).not.toHaveBeenCalled();

    outbox.handle(turnCompleted("completed"));
    await outbox.close();

    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "工具查询 · 已完成\n\nMCP 工具：1 次\n动态工具：1 次\n\n总耗时：250毫秒",
      "本次运行 · 已完成",
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

  it("reports overload without interrupting in-flight or queued critical output", async () => {
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
    expect(outbox.notifyText(target, "overloaded")).toBe(false);

    releaseFirst();
    await outbox.close();
    expect(sent).toEqual(["first", "second"]);
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
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    operation: {
      itemId,
      kind,
      detail: "git status --short",
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
    turnId: "turn",
    status,
  };
}
