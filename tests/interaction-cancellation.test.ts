import type { Bot } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { InteractionRouter, type InteractionRequest } from "../src/approval/index.js";
import { TelegramInteractionPort } from "../src/surfaces/telegram/interactions.js";
import { TelegramOutbox } from "../src/surfaces/telegram/outbox.js";
import { FeishuInteractionPort, FeishuOutbox } from "../src/surfaces/feishu/index.js";
import { WeixinInteractionPort, WeixinOutbox, WeixinReplyContextStore } from "../src/surfaces/weixin/index.js";
import { PendingInteractionRegistry, type PendingInteractionRecord } from "../src/surfaces/pending-interaction-registry.js";

const logger = pino({ level: "silent" });
const request: InteractionRequest = {
  type: "approval", requestId: "request-1", threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
  kind: "command", title: "Approval", detail: "npm test", allowSession: false, expiresInMs: 30_000,
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

it("releases Telegram output ownership before a slow status update and a replacement request", async () => {
  let release!: () => void;
  let messageId = 0;
  const edit = vi.fn(async () => true as const).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return true;
  });
  const bot = { callbackQuery: vi.fn(), api: {
    sendMessage: async () => ({ message_id: ++messageId }), editMessageText: edit,
  } } as unknown as Bot;
  const outbox = new TelegramOutbox(bot.api, logger);
  const finish = vi.spyOn(outbox, "finishInteraction");
  const port = new TelegramInteractionPort(bot, logger, undefined, outbox);
  const router = new InteractionRouter();
  const target = { surface: "telegram" as const, accountId: "account", conversationId: "chat" };
  router.register(target.surface, target.accountId, port);
  const old = router.request(target, request);
  await settle();
  router.resolved(request.requestId);
  await old;
  expect(finish).toHaveBeenCalledOnce();
  const replacement = router.request(target, { ...request });
  await settle();
  release();
  await settle();
  expect(finish).toHaveBeenCalledOnce();
  expect(router.hasPendingForThread(request.threadId)).toBe(true);
  router.resolved(request.requestId);
  await replacement;
  expect(finish).toHaveBeenCalledTimes(2);
  await port.close();
  await outbox.close();
});

it("releases preparation capacity immediately without letting late cleanup cancel a replacement", () => {
  const registry = new PendingInteractionRegistry<PendingInteractionRecord>(1);
  const cleanup = vi.fn();
  expect(registry.reserve("request", "old-token", cleanup)).toBe(true);
  const oldSignal = registry.signal("old-token");
  expect(registry.reserve("other", "other-token")).toBe(false);
  registry.resolved("request");
  expect(oldSignal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(registry.reserve("request", "new-token", cleanup)).toBe(true);
  const newSignal = registry.signal("new-token");
  registry.release("request", "old-token");
  expect(newSignal.aborted).toBe(false);
  expect(cleanup).toHaveBeenCalledOnce();
  registry.cancelPreparing();
  expect(newSignal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(registry.reserve("other", "other-token")).toBe(true);
  registry.cancelPreparing();
});

describe.each(["telegram", "feishu", "weixin"] as const)("%s interaction cancellation through the real Outbox", (surface) => {
  it("releases reservations when the preparation hook throws", async () => {
    const fixture = createFixture(surface);
    vi.spyOn(fixture.outbox, "prepareInteraction").mockImplementationOnce(() => { throw new Error("fixture preparation failure"); });
    await expect(fixture.router.request(fixture.target, request)).rejects.toThrow("fixture preparation failure");
    const next = fixture.router.request(fixture.target, request);
    await settle();
    expect(fixture.send).toHaveBeenCalledOnce();
    fixture.release();
    await settle();
    expect(fixture.router.hasPendingForThread(request.threadId)).toBe(true);
    fixture.router.resolved(request.requestId);
    await next;
    await fixture.close();
  });

  it("removes a cancelled queued prompt before the platform send begins", async () => {
    const fixture = createFixture(surface);
    const blocker = fixture.block();
    await settle();
    const decision = fixture.router.request(fixture.target, request);
    fixture.router.cancelThreads(new Set([request.threadId]));
    await expect(decision).resolves.toEqual({ type: "approval", approved: false });
    fixture.release();
    await blocker;
    await settle();
    if (surface === "weixin") {
      // Weixin can send a cancellation receipt, but must never send the queued prompt.
      expect(fixture.texts.some((text) => text.includes("npm test"))).toBe(false);
      expect(fixture.texts[0]).toBe("block");
    } else {
      expect(fixture.send).toHaveBeenCalledOnce();
    }
    await fixture.close();
  });

  it.each([false, true])("releases preparing IDs before a late send finishes (reject=%s)", async (reject) => {
    const fixture = createFixture(surface);
    const old = fixture.router.request(fixture.target, request);
    await settle();
    fixture.router.cancelThreads(new Set([request.threadId]));
    await old;
    const next = fixture.router.request(fixture.target, request);
    let nextSettled = false;
    void next.then(() => { nextSettled = true; });
    await settle();
    expect(nextSettled).toBe(false);
    fixture.release(reject);
    await settle();
    expect(fixture.send.mock.calls.length).toBeGreaterThan(1);
    expect(nextSettled).toBe(false);
    expect(fixture.router.hasPendingForThread(request.threadId)).toBe(true);
    fixture.router.resolved(request.requestId);
    await expect(next).resolves.toEqual({ type: "approval", approved: false });
    await fixture.close();
  });
});

function createFixture(surface: "telegram" | "feishu" | "weixin") {
  const accountId = "account-fixture@im.bot";
  const actorId = "actor-fixture@im.wechat";
  const target = { surface, accountId, conversationId: actorId };
  let release!: (reject?: boolean) => void;
  const send = vi.fn(async () => {});
  send.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    release = (fail = false) => fail ? reject(new Error("fixture send failure")) : resolve();
  }));
  let messageId = 0;
  const texts: string[] = [];
  const actors = { actors: () => [actorId], rememberActor: () => {} };
  const access = { isAllowed: () => true };
  let port: TelegramInteractionPort | FeishuInteractionPort | WeixinInteractionPort;
  let outbox: TelegramOutbox | FeishuOutbox | WeixinOutbox;
  let block: () => Promise<unknown>;
  if (surface === "telegram") {
    const bot = { callbackQuery: vi.fn(), api: {
      sendMessage: async () => { const id = ++messageId; await send(); return { message_id: id }; },
      editMessageText: async () => true,
    } } as unknown as Bot;
    const output = new TelegramOutbox(bot.api, logger);
    port = new TelegramInteractionPort(bot, logger, undefined, output);
    block = () => output.runOrdered(actorId, () => send());
    outbox = output;
  } else if (surface === "feishu") {
    const output = new FeishuOutbox(accountId, {
      sendText: () => send(), sendPost: () => send(),
      sendCard: async () => { const id = ++messageId; await send(); return `message-${id}`; },
      updateCard: async () => {}, sendMarkdownCard: async () => {},
      createStreamingCard: async () => ({ cardId: "card", messageId: "message" }),
      updateStreamingCard: async () => {}, finishStreamingCard: async () => {},
    }, logger);
    port = new FeishuInteractionPort(output, actors, access, logger);
    block = () => output.deliverText(actorId, "block");
    outbox = output;
  } else {
    const contexts = new WeixinReplyContextStore(accountId);
    contexts.remember(target, actorId, "fixture-context");
    const output = new WeixinOutbox(accountId, { sendText: (input) => {
      texts.push(input.text);
      return send();
    } }, contexts, access, logger);
    port = new WeixinInteractionPort(output, actors, access, logger);
    block = () => output.deliverText(target, "block");
    outbox = output;
  }
  const router = new InteractionRouter();
  router.register(surface, accountId, port);
  return { target, router, outbox, send, texts, block, release: (reject?: boolean) => release(reject), close: async () => {
    await port.close();
    await outbox.close();
  } };
}
