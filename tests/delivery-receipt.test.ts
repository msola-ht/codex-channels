import { GrammyError, type Api } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";
import { FeishuOutbox } from "../src/surfaces/feishu/index.js";
import { FeishuMessageError } from "../src/surfaces/feishu/message-error.js";
import { WeixinOutbox, WeixinReplyContextStore } from "../src/surfaces/weixin/index.js";
import { captureDelivery, checkpointDelivery, type DeliveryCheckpoint } from "../src/surfaces/delivery-receipt.js";
import { ConversationDeliveryQueue } from "../src/surfaces/conversation-delivery-queue.js";

const logger = pino({ level: "silent" });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe.each(["telegram", "feishu", "weixin"] as const)("%s durable acknowledgement", (surface) => {
  it.each([false, true])("waits for the actual platform outcome (unknown=%s)", async (unknown) => {
    let finish: (() => void) | undefined;
    const send = vi.fn(() => new Promise<string>((resolve, reject) => {
      finish = () => unknown ? reject(new Error("ambiguous network failure")) : resolve("message-1");
    }));
    const target = { surface, accountId: surface === "weixin" ? "fixture@im.bot" : "default", conversationId: surface === "weixin" ? "actor@im.wechat" : "chat" };
    const contexts = new WeixinReplyContextStore("fixture@im.bot");
    if (surface === "weixin") contexts.remember(target, target.conversationId, "reply-context");
    const outbox = surface === "telegram"
      ? new TelegramOutbox({ sendMessage: async () => { await send(); return { message_id: 1 }; } } as unknown as Api, logger)
      : surface === "feishu"
        ? new FeishuOutbox("default", {
          sendText: async () => { await send(); }, sendPost: async () => { await send(); },
          sendMarkdownCard: send, sendCard: send, updateCard: async () => { await send(); },
          createStreamingCard: async () => ({ cardId: "card", messageId: await send() }),
          updateStreamingCard: async () => { await send(); }, finishStreamingCard: async () => { await send(); },
        }, logger)
        : new WeixinOutbox(target.accountId, { sendText: async () => { await send(); } }, contexts, { isAllowed: () => true }, logger);
    const checkpoints: DeliveryCheckpoint[] = [];
    const event: OutputEvent = { type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", phase: "final_answer", text: "durable final answer" };
    let settled = false;
    const delivery = outbox.deliver(event, new AbortController().signal, async (value) => { checkpoints.push(value); });
    const observed = delivery.then(() => { settled = true; return "confirmed"; }, () => { settled = true; return "uncertain"; });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(checkpoints.map((value) => value.state)).toEqual(["started"]);
      finish!();
      expect(await observed).toBe(unknown ? "uncertain" : "confirmed");
      expect(checkpoints.map((value) => value.state)).toEqual(unknown ? ["started"] : ["started", "confirmed"]);
      expect(send).toHaveBeenCalledOnce();
    } finally { finish?.(); await outbox.close(); }
  });
});

it("does not acknowledge a swallowed send failure or invoke a fallback with unknown outcome", async () => {
  const calls: string[] = [];
  const delivery = new ConversationDeliveryQueue(logger, { component: "fixture" });
  try {
    await expect(captureDelivery(() => {
      delivery.enqueue("chat", async () => {
        try { await checkpointDelivery("first", async () => { calls.push("first"); throw new Error("network"); }); }
        catch { await checkpointDelivery("fallback", async () => { calls.push("fallback"); }); }
      }, true);
    }, new AbortController().signal, async () => {})).rejects.toThrow("network");
    expect(calls).toEqual(["first"]);
  } finally { await delivery.close(); }
});

it.each(["telegram", "feishu"] as const)("preserves the proven-safe %s format fallback within a durable receipt", async (surface) => {
  const target = { surface, accountId: "default", conversationId: "chat" };
  const checkpoints: DeliveryCheckpoint[] = [];
  const send = vi.fn(async () => ({ message_id: 1 })).mockRejectedValueOnce(new GrammyError("rejected", {
    ok: false, error_code: 400, description: "Bad Request: can't parse entities",
  }, "sendMessage", {}));
  const post = vi.fn(async () => {});
  const outbox = surface === "telegram" ? new TelegramOutbox({ sendMessage: send } as unknown as Api, logger)
    : new FeishuOutbox("default", {
      sendText: post, sendPost: post,
      sendMarkdownCard: async () => { throw new FeishuMessageError("card-create-failed", "no message sent"); },
      sendCard: async () => "message", updateCard: async () => {},
      createStreamingCard: async () => ({ cardId: "card", messageId: "message" }),
      updateStreamingCard: async () => {}, finishStreamingCard: async () => {},
    }, logger);
  try {
    await outbox.deliver({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "item", text: "final answer", phase: "final_answer" },
      new AbortController().signal, async (value) => { checkpoints.push(value); });
    expect(checkpoints.map((value) => value.state)).toEqual(["started", "rejected", "started", "confirmed"]);
    if (surface === "telegram") expect(send).toHaveBeenCalledTimes(2);
    else expect(post).toHaveBeenCalledOnce();
  } finally { await outbox.close(); }
});

it("cancels an ordered durable operation while queued and releases its receipt", async () => {
  const queue = new ConversationDeliveryQueue(logger, { component: "fixture" });
  let release!: () => void;
  queue.enqueue("chat", () => new Promise<void>((resolve) => { release = resolve; }), true);
  await settle();
  const abort = new AbortController();
  const send = vi.fn(async () => {});
  let ordered!: Promise<void>;
  const receipt = captureDelivery(() => {
    ordered = queue.runOrdered("chat", send, abort.signal);
    void ordered.catch(() => {});
  }, new AbortController().signal, async () => {});
  void receipt.catch(() => {});
  abort.abort();
  await expect(ordered).rejects.toThrow("取消");
  await expect(receipt).rejects.toThrow("取消");
  release();
  await queue.close();
  expect(send).not.toHaveBeenCalled();
});

it.each(["started", "confirmed"] as const)("does not acknowledge a failed %s checkpoint", async (failure) => {
  const queue = new ConversationDeliveryQueue(logger, { component: "fixture" });
  const send = vi.fn(async () => "message");
  try {
    await expect(captureDelivery(() => {
      queue.enqueue("chat", async () => { await checkpointDelivery("send", send); }, true);
    }, new AbortController().signal, async (value) => {
      if (value.state === failure) throw new Error("checkpoint storage failure");
    })).rejects.toThrow("checkpoint storage failure");
    expect(send).toHaveBeenCalledTimes(failure === "started" ? 0 : 1);
  } finally { await queue.close(); }
});

it("rejects an output that never schedules a delivery", async () => {
  await expect(captureDelivery(() => {}, new AbortController().signal, async () => {})).rejects.toThrow("未产生投递操作");
});

it("filters hidden operations at intake and refuses to acknowledge an older retained operation under a changed policy", async () => {
  const send = vi.fn(async () => ({ message_id: 1 }));
  const outbox = new TelegramOutbox({ sendMessage: send } as unknown as Api, logger, undefined, { operationUpdateDisplay: "hidden" });
  const event: OutputEvent = {
    type: "operation.updated", target: { surface: "telegram", accountId: "default", conversationId: "chat" },
    threadId: "thread", turnId: "turn", operation: { kind: "command", status: "completed", itemId: "item" },
  };
  try {
    expect(outbox.retains(event)).toBe(false);
    await expect(outbox.deliver(event, new AbortController().signal, async () => {})).rejects.toThrow("展示规则");
    expect(send).not.toHaveBeenCalled();
    const compaction: OutputEvent = { ...event, operation: { ...event.operation, kind: "contextCompaction" } };
    expect(outbox.retains(compaction)).toBe(true);
    await outbox.deliver(compaction, new AbortController().signal, async () => {});
    await outbox.deliver(compaction, new AbortController().signal, async () => {});
    expect(send).toHaveBeenCalledTimes(2);
  } finally { await outbox.close(); }
});
