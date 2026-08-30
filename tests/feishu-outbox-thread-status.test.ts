import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationTarget,
  OutputEvent,
} from "../src/conversation-core/index.js";
import {
  feishuCardElements,
  FeishuOutbox,
  type FeishuCardDocument,
} from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu",
  accountId: "cli_app",
  conversationId: "oc_chat",
} as const;

export const turnCompletedMarkdown = "## 本次运行 · 已完成\n\n- Session：测试会话\n- Session ID：thread-1";

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


describe("Feishu outbox thread status", () => {
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

});

export function completed(
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

export function operationUpdated(
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

export function delta(text: string, itemId = "item-1"): OutputEvent {
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

export function turnCompleted(): OutputEvent {
  return {
    type: "turn.completed",
    target,
    threadId: "thread-1",
    sessionName: "测试会话",
    turnId: "turn-1",
    status: "completed",
  };
}

export function planUpdated(
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

export function deferred(): {
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

export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
