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

  it("replaces the start bubble with typing and sends final text and completion", async () => {
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
    expect(events.indexOf("typing:stop")).toBeLessThan(
      events.indexOf("text:send"),
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

  it("splits without breaking surrogate pairs and truncates after five chunks", async () => {
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
    second.outbox.handle(completed(
      "final_answer",
      "测".repeat(20_001),
    ));
    await second.outbox.close();

    const truncatedChunks = second.sendText.mock.calls.map(
      ([input]) => input.text,
    );
    expect(truncatedChunks).toHaveLength(5);
    expect(truncatedChunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(truncatedChunks.join("")).toHaveLength(20_000);
    expect(truncatedChunks.at(-1)).toMatch(/\[内容过长，已截断\]$/u);
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
  options: WeixinOutboxOptions = {},
  sendTextImpl: WeixinProtocolClient["sendText"] = async () => {},
) {
  const contexts = new WeixinReplyContextStore(accountId);
  contexts.remember(target, actorId, "context-secret");
  const sendText = vi.fn<WeixinProtocolClient["sendText"]>(sendTextImpl);
  const onReplyContextInvalidated = vi.fn(async () => {});
  return {
    contexts,
    sendText,
    onReplyContextInvalidated,
    outbox: new WeixinOutbox(
      accountId,
      { sendText },
      contexts,
      accessFixture(() => allowed.value),
      pino({ level: "silent" }),
      {
        ...options,
        onReplyContextInvalidated,
      },
    ),
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
): Extract<OutputEvent, { type: "operation.updated" }> {
  return {
    type: "operation.updated",
    target,
    threadId: "thread",
    turnId: "turn",
    operation: {
      itemId: "command",
      kind: "command",
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
