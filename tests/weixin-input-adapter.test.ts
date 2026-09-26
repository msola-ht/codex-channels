import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { ConversationTurnUseCases } from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { resolveWeixinQuotedText } from "../src/surfaces/weixin/quoted-reference.js";
import { parseUpdatesResponse } from "../src/surfaces/weixin/inbound-message-parser.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../src/policy/index.js";
import {
  WeixinInputAdapter as ProductionWeixinInputAdapter,
  WeixinInputFatalError,
  WeixinProtocolError,
  WeixinReplyContextStore,
  type WeixinProtocolClient,
  type WeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";
import {
  conversationCommandExecutor,
  conversationInputUseCases,
  conversationStatus,
  type ConversationMethodOverrides,
} from "./conversation-command-fixture.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target: ConversationTarget = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
};

describe("Weixin quote resolution", () => {
  it("uses cached text along with the platform summary", () => {
    expect(resolveWeixinQuotedText({ quotedMessageId: "7", quotedTitle: "摘要" }, { text: "完整原文", truncated: false }))
      .toBe("完整原文 | 摘要");
    expect(resolveWeixinQuotedText({ quotedText: "平台正文", quotedTitle: "摘要" }, { text: "缓存正文", truncated: false }))
      .toBe("平台正文 | 摘要");
  });

  it.each([0, 1])("resolves the hash-verified partial quote using end interpretation %s", (endindex) => {
    const selected = "甲中乙";
    expect(resolveWeixinQuotedText({ quotedPartial: {
      start: "甲", end: "乙", startindex: 0, endindex,
      quotemd5: createHash("md5").update(selected).digest("hex"),
    } }, { text: "乙前甲中乙后", truncated: false })).toBe(selected);
  });

  it("does not substitute the whole message when the partial quote is unavailable", () => {
    const reference = { quotedPartial: {
      start: "甲", end: "乙", startindex: 0, endindex: 0, quotemd5: "0".repeat(32),
    } };
    expect(resolveWeixinQuotedText(reference, { text: "甲中乙", truncated: false })).toBe("[局部引用无法还原，请重新发送所选文字]");
    expect(resolveWeixinQuotedText(reference, undefined)).toBe("[局部引用无法还原，请重新发送所选文字]");
  });
});

type ProductionWeixinInputOptions = ConstructorParameters<
  typeof ProductionWeixinInputAdapter
>[0];
type TestWeixinInputOptions = Omit<
  ProductionWeixinInputOptions,
  "service" | "commands"
> & {
  service: ConversationMethodOverrides;
};

class WeixinInputAdapter extends ProductionWeixinInputAdapter {
  constructor(options: TestWeixinInputOptions) {
    const { service, ...rest } = options;
    super({
      ...rest,
      service: conversationInputUseCases(service),
      commands: conversationCommandExecutor(service),
    });
  }
}

const imageFixtureDirectory = mkdtempSync(join(tmpdir(), "codex-weixin-input-images-"));
const pngImagePath = join(imageFixtureDirectory, "image.png");
const jpegImagePath = join(imageFixtureDirectory, "image.jpg");
writeFileSync(pngImagePath, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]), { mode: 0o600 });
writeFileSync(jpegImagePath, Buffer.from([0xff, 0xd8, 0xff]), { mode: 0o600 });
const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";
const jpegDataUrl = "data:image/jpeg;base64,/9j/";

afterAll(() => {
  rmSync(imageFixtureDirectory, { recursive: true, force: true });
});

describe("WeixinInputAdapter", () => {
  it("keeps the latest reply context when stop overtakes older ordinary messages", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = serviceFixture(async (_target, text) => {
      if (text === "first") await gate;
      return { threadId: "thread", turnId: "turn", steered: false };
    });
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: async (_cursor, signal) => {
        if (delivered) return waitForAbort(signal);
        delivered = true;
        return { cursor: "cursor", messages: ["first", "second", "/stop"].map((text, index) => ({
          kind: "text" as const, messageId: String(index), actorId, conversationId: actorId,
          contextToken: `context-${index}`, text,
        })) };
      }, sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const replyContexts = new WeixinReplyContextStore(accountId);
    const persistReplyContext = vi.fn(async () => {});
    const handleText = vi.fn(async (_target: ConversationTarget, _actor: string, text: string) => text === "/stop" ? "handled" as const : "not-command" as const);
    const adapter = new WeixinInputAdapter({ accountId, client, cursorStore, service,
      outbox: outboxFixture(), access: accessFixture(true), replyContexts, persistReplyContext,
      interactions: { handleText }, onFatal: vi.fn(),
    });
    try {
      await adapter.start();
      await vi.waitFor(() => expect(handleText).toHaveBeenCalledWith(target, actorId, "/stop"));
      expect(cursorStore.set).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor"));
      expect(replyContexts.get(target)?.contextToken).toBe("context-2");
      expect(persistReplyContext.mock.calls.at(-1)).toEqual([target, actorId, "context-2"]);
    } finally {
      release();
      await adapter.stop();
    }
  });

  it("authorizes, remembers the actor, submits text, and commits afterward", async () => {
    const events: string[] = [];
    const controller = clientFixture();
    const cursorStore = cursorStoreFixture((cursor) => {
      events.push(`cursor:${cursor}`);
    });
    const access = accessFixture(true, events);
    const actorRegistry = actorRegistryFixture(events);
    const replyContexts = new WeixinReplyContextStore(accountId);
    const service = serviceFixture(async () => {
      events.push("submit");
      return { threadId: "thread", turnId: "turn", steered: false };
    });
    const onFatal = vi.fn();
    const adapter = new WeixinInputAdapter({
      accountId,
      client: controller.client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access,
      replyContexts,
      actorRegistry,
      onFatal,
    });

    await adapter.start();
    controller.deliver("cursor-one");
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(events).toEqual([
      "access",
      "actor",
      "submit",
      "cursor:cursor-one",
    ]);
    expect(service.submit).toHaveBeenCalledWith(target, "hello", expect.any(AbortSignal));
    expect(actorRegistry.rememberActor).toHaveBeenCalledWith(target, actorId);
    expect(replyContexts.get(target)).toEqual({
      actorId,
      contextToken: "context-secret",
    });
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("routes exact approval commands before ordinary conversation input", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-approval",
            messages: [{
              kind: "text" as const,
              messageId: "approval-message",
              actorId,
              conversationId: actorId,
              contextToken: "context-approval",
              text: "/批准一次 opaque-token",
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const interactions = {
      handleText: vi.fn(async () => "handled" as const),
    };
    const service = serviceFixture();
    const cursorStore = cursorStoreFixture();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      interactions,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-approval",
      );
    });
    await adapter.stop();

    expect(interactions.handleText).toHaveBeenCalledWith(
      target,
      actorId,
      "/批准一次 opaque-token",
    );
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("keeps bare numbers as ordinary conversation text", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-number",
            messages: [{
              kind: "text" as const,
              messageId: "number-message",
              actorId,
              conversationId: actorId,
              contextToken: "context-number",
              text: "1",
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const interactions = {
      handleText: vi.fn(async () => "not-command" as const),
    };
    const service = serviceFixture();
    const cursorStore = cursorStoreFixture();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      interactions,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-number");
    });
    await adapter.stop();

    expect(service.submit).toHaveBeenCalledWith(target, "1", expect.any(AbortSignal));
  });

  it("composes live polling health into the shared /status reply", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-status",
            messages: [{
              kind: "text" as const,
              messageId: "status-1",
              actorId,
              conversationId: actorId,
              contextToken: "context-status",
              text: "/status",
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const outbox = outboxFixture();
    const service = {
      ...serviceFixture(),
      status: vi.fn(() => conversationStatus({
        threadId: "thread",
        model: "gpt-test",
        effort: "medium",
      })),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service,
      outbox,
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(outbox.notifyText).toHaveBeenCalledWith(
        target,
        expect.stringContaining(
          "- 微信链路：轮询中\n- 连续失败：0 次\n- 上次后台轮询：",
        ),
      );
    }, { timeout: 2_000 });
    await adapter.stop();
  });

  it.each([
    { name: "ordinary quote", original: "原始用户消息", title: "摘要", partial: undefined,
      expected: "原始用户消息 | 摘要" },
    { name: "artificial cache ellipsis", original: "前".repeat(7999) + "甲" + "乙".repeat(100) + "…",
      title: "摘要", partial: { start: "甲", end: "…", startindex: 0, endindex: 0, quotemd5: "" },
      expected: "[局部引用无法还原，请重新发送所选文字]" },
    { name: "selection within a truncated cache", original: "甲乙" + "后".repeat(9000), title: "摘要",
      partial: { start: "甲", end: "乙", startindex: 0, endindex: 0, quotemd5: "" }, expected: "甲乙 | 摘要" },
    { name: "unicode cache boundary", original: "图".repeat(7998) + "甲😀" + "后".repeat(100), title: "摘要",
      partial: { start: "甲", end: "😀", startindex: 0, endindex: 0,
        quotemd5: createHash("md5").update("甲😀").digest("hex") }, expected: "甲😀 | 摘要" },
    { name: "long summary", original: "必须保留的原文", title: "摘".repeat(8000), partial: undefined,
      expected: "必须保留的原文" },
    { name: "long summary with selection", original: "前甲乙后", title: "摘".repeat(8000),
      partial: { start: "甲", end: "乙", startindex: 0, endindex: 0, quotemd5: "" }, expected: "甲乙" },
    { name: "long summary with unavailable selection", original: "原始用户消息", title: "摘".repeat(8000),
      partial: { start: "甲", end: "乙", startindex: 0, endindex: 0, quotemd5: "" },
      expected: "[局部引用无法还原，请重新发送所选文字]" },
  ])("preserves quote content across the full input pipeline: $name", async ({ original, title, partial, expected }) => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          const raw = JSON.stringify({
            ret: 0, get_updates_buf: "cursor-quote",
            msgs: [original, "引用测试"].map((text, index) => ({
              message_id: index === 0 ? "9007199254740993123" : "101",
              message_type: 1, message_state: 2, from_user_id: actorId, to_user_id: accountId,
              context_token: "context-fixture", item_list: [{ type: 1, text_item: { text },
                ...(index === 0 ? {} : { ref_msg: { svr_id: "9007199254740993123", title,
                  ...(partial === undefined ? {} : { partial_text: partial }),
                } }),
              }],
            })),
          }).replace(/"(message_id|svr_id)":"(\d+)"/gu, '"$1":$2');
          return parseUpdatesResponse(raw, accountId);
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-quote",
      );
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(service.submit).toHaveBeenNthCalledWith(
      1,
      target,
      original, expect.any(AbortSignal),
    );
    expect(service.submit).toHaveBeenNthCalledWith(
      2,
      target,
      expect.stringContaining(`\n> ${expected}`), expect.any(AbortSignal),
    );
    const submitted = vi.mocked(service.submit).mock.calls[1]?.[1];
    expect(submitted).toEqual(expect.stringContaining("\n\n当前消息：\n引用测试"));
    expect(submitted).not.toEqual(expect.stringContaining("甲…"));
  });

  it("marks a missing quote without inventing its contents", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-quote-miss",
            messages: [{
              kind: "text" as const,
              messageId: "102",
              actorId,
              conversationId: actorId,
              contextToken: "context-reply",
              text: "重启后的引用测试",
              quotedMessageId: "unknown",
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-quote-miss",
      );
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(service.submit).toHaveBeenCalledWith(
      target,
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：\n> [引用正文不在当前进程缓存中，请重新发送原文]\n\n当前消息：\n重启后的引用测试",
      expect.any(AbortSignal),
    );
  });

  it("does not cache quoted text from an unauthorized Weixin message", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-unauthorized-quote",
            messages: [
              {
                kind: "text" as const,
                messageId: "200",
                actorId,
                conversationId: actorId,
                contextToken: "context-original",
                text: "未授权消息",
              },
              {
                kind: "text" as const,
                messageId: "201",
                actorId,
                conversationId: actorId,
                contextToken: "context-reply",
                text: "当前已授权消息",
                quotedMessageId: "200",
              },
            ],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const access: SurfaceAccessPolicy = {
      isAllowed: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access,
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-unauthorized-quote",
      );
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(service.submit).toHaveBeenCalledOnce();
    expect(service.submit).toHaveBeenCalledWith(
      target,
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：\n> [引用正文不在当前进程缓存中，请重新发送原文]\n\n当前消息：\n当前已授权消息",
      expect.any(AbortSignal),
    );
  });

  it("commits unauthorized messages without recording or submitting them", async () => {
    const controller = clientFixture();
    const cursorStore = cursorStoreFixture();
    const access = accessFixture(false);
    const actorRegistry = actorRegistryFixture();
    const service = serviceFixture();
    const replyContexts = new WeixinReplyContextStore(accountId);
    replyContexts.remember(target, actorId, "previous-context");
    const adapter = new WeixinInputAdapter({
      accountId,
      client: controller.client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access,
      replyContexts,
      actorRegistry,
      onFatal: vi.fn(),
    });

    await adapter.start();
    controller.deliver("cursor-one");
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
    });
    await adapter.stop();

    expect(access.isAllowed).toHaveBeenCalledWith({ target, actorId });
    expect(actorRegistry.rememberActor).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
    expect(replyContexts.get(target)).toBeUndefined();
  });

  it("downloads authorized mixed images and submits them together", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-image",
            messages: [{
              kind: "image" as const,
              messageId: "9007199254740993",
              actorId,
              conversationId: actorId,
              contextToken: "context-secret",
              text: "比较图片",
              images: [
                {
                  fullUrl:
                    "https://novac2c.cdn.weixin.qq.com/c2c/download?first",
                  imageAesKey: "00112233445566778899aabbccddeeff",
                },
                { encryptedQueryParam: "second-private-query" },
              ],
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const images = {
      download: vi.fn()
        .mockResolvedValueOnce({
          path: pngImagePath,
          mimeType: "image/png" as const,
          bytes: 8,
        })
        .mockResolvedValueOnce({
          path: jpegImagePath,
          mimeType: "image/jpeg" as const,
          bytes: 9,
        }),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      images,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-image",
      );
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(images.download).toHaveBeenNthCalledWith(1, {
      fullUrl:
        "https://novac2c.cdn.weixin.qq.com/c2c/download?first",
      imageAesKey: "00112233445566778899aabbccddeeff",
    });
    expect(images.download).toHaveBeenNthCalledWith(2, {
      encryptedQueryParam: "second-private-query",
    });
    expect(service.submit).toHaveBeenCalledWith(target, {
      text: "比较图片",
      images: [
        { url: pngDataUrl },
        { url: jpegDataUrl },
      ],
    }, expect.any(AbortSignal));
  });

  it("submits separate image messages immediately and persists reply contexts in order", async () => {
    let delivered = false;
    let releaseFirstPersistence!: () => void;
    const firstPersistence = new Promise<void>((resolve) => {
      releaseFirstPersistence = resolve;
    });
    const persistReplyContext = vi.fn(async (
      _target: ConversationTarget,
      _actorId: string,
      contextToken: string,
    ) => {
      if (contextToken === "context-first") {
        await firstPersistence;
      }
    });
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-images",
            messages: [
              {
                kind: "image" as const,
                messageId: "9007199254740993",
                actorId,
                conversationId: actorId,
                contextToken: "context-first",
                text: "比较这些图片",
                images: [{ encryptedQueryParam: "first-private-query" }],
              },
              {
                kind: "image" as const,
                messageId: "9007199254740994",
                actorId,
                conversationId: actorId,
                contextToken: "context-second",
                images: [{ encryptedQueryParam: "second-private-query" }],
              },
            ],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const images = {
      download: vi.fn()
        .mockResolvedValueOnce({
          path: pngImagePath,
          mimeType: "image/png" as const,
          bytes: 8,
        })
        .mockResolvedValueOnce({
          path: jpegImagePath,
          mimeType: "image/jpeg" as const,
          bytes: 9,
        }),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      persistReplyContext,
      images,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(persistReplyContext).toHaveBeenCalledOnce();
    });
    expect(persistReplyContext.mock.calls[0]?.[2]).toBe("context-first");
    releaseFirstPersistence();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-images",
      );
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(persistReplyContext.mock.calls.map((call) => call[2])).toEqual([
      "context-first",
      "context-second",
    ]);
    expect(service.submit).toHaveBeenCalledTimes(2);
    expect(service.submit).toHaveBeenNthCalledWith(1, target, {
      text: "比较这些图片",
      images: [{ url: pngDataUrl }],
    }, expect.any(AbortSignal));
    expect(service.submit).toHaveBeenNthCalledWith(2, target, {
      text: "请查看这张图片并根据图片内容协助我。",
      images: [{ url: jpegDataUrl }],
    }, expect.any(AbortSignal));
  });

  it("commits an unauthorized image without contacting its CDN", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return imageBatch("cursor-image");
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const images = {
      download: vi.fn(),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(false),
      replyContexts: new WeixinReplyContextStore(accountId),
      images,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-image",
      );
    });
    await adapter.stop();

    expect(images.download).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("downloads and submits an authorized UTF-8 text file", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-file",
            messages: [{
              kind: "file" as const,
              messageId: "9007199254740995",
              actorId,
              conversationId: actorId,
              contextToken: "context-file",
              file: {
                fileName: "settings.json",
                encryptedQueryParam: "private-query",
                mediaAesKey: "private-key",
              },
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const files = {
      download: vi.fn(async () => ({
        fileName: "settings.json",
        text: "{\"enabled\":true}",
        bytes: 16,
      })),
    };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      files,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-file",
      );
    }, { timeout: 2_000 });
    await adapter.stop();

    expect(files.download).toHaveBeenCalledWith({
      fileName: "settings.json",
      encryptedQueryParam: "private-query",
      mediaAesKey: "private-key",
    });
    expect(service.submit).toHaveBeenCalledWith(
      target,
      expect.stringContaining("{\"enabled\":true}"), expect.any(AbortSignal),
    );
  });

  it("commits an unauthorized file without contacting its CDN", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-file",
            messages: [{
              kind: "file" as const,
              messageId: "9007199254740996",
              actorId,
              conversationId: actorId,
              contextToken: "context-file",
              file: {
                fileName: "private.txt",
                encryptedQueryParam: "private-query",
              },
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const files = { download: vi.fn() };
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(false),
      replyContexts: new WeixinReplyContextStore(accountId),
      files,
      onFatal: vi.fn(),
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(
        accountId,
        "cursor-file",
      );
    });
    await adapter.stop();

    expect(files.download).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("reports a constrained fatal error and preserves the cursor on submission failure", async () => {
    const controller = clientFixture();
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture(async () => {
      throw new Error("private application detail");
    });
    const onFatal = vi.fn();
    const adapter = new WeixinInputAdapter({
      accountId,
      client: controller.client,
      cursorStore,
      service,
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    controller.deliver("cursor-one");
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledOnce();
    }, { timeout: 2_000 });
    await adapter.stop();

    const error = onFatal.mock.calls[0]?.[0] as WeixinInputFatalError;
    expect(error).toBeInstanceOf(WeixinInputFatalError);
    expect(error).toMatchObject({
      code: "message-processing",
      message: "微信消息接收已停止",
    });
    expect(error.message).not.toContain("private");
    expect(cursorStore.set).not.toHaveBeenCalled();
  });

  it("reports an unexpected protocol abort as fatal", async () => {
    const onFatal = vi.fn();
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async () => {
        throw new WeixinProtocolError("aborted", "unexpected abort");
      }),
      sendText: vi.fn(async () => {}),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({
        code: "aborted",
        message: "微信消息接收已停止",
      }));
    });
    await adapter.stop();
  });

  it("can start a fresh update monitor after a fatal abort", async () => {
    let attempts = 0;
    const onFatal = vi.fn();
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        attempts += 1;
        if (attempts === 1) {
          throw new WeixinProtocolError("aborted", "unexpected abort");
        }
        return await waitForAbort(signal);
      }),
      sendText: vi.fn(async () => {}),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    await adapter.start();
    await vi.waitFor(() => {
      expect(client.getUpdates).toHaveBeenCalledTimes(2);
    });

    await adapter.stop();
  });

  it("starts once and stops repeated calls without reporting cancellation as fatal", async () => {
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const onFatal = vi.fn();
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal,
    });

    await adapter.start();
    await adapter.start();
    await vi.waitFor(() => {
      expect(client.getUpdates).toHaveBeenCalledOnce();
    });

    const firstStop = adapter.stop();
    const secondStop = adapter.stop();
    expect(firstStop).toBe(secondStop);
    await firstStop;
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("bounds shutdown when an injected client ignores cancellation", async () => {
    const onStopTimeout = vi.fn();
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn<WeixinProtocolClient["getUpdates"]>(
        () => new Promise<never>(() => {}),
      ),
      sendText: vi.fn(async () => {}),
    };
    const adapter = new WeixinInputAdapter({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      outbox: outboxFixture(),
      access: accessFixture(true),
      replyContexts: new WeixinReplyContextStore(accountId),
      onFatal: vi.fn(),
      onStopTimeout,
      closeTimeoutMs: 1,
    });

    await adapter.start();
    await adapter.stop();

    expect(onStopTimeout).toHaveBeenCalledOnce();
  });
});

function clientFixture(): {
  client: WeixinProtocolClient;
  deliver(cursor: string): void;
} {
  let deliver: ((cursor: string) => void) | undefined;
  let delivered = false;
  const client: WeixinProtocolClient = {
    getUpdates: vi.fn<WeixinProtocolClient["getUpdates"]>(
      async (_cursor, signal) => {
        if (!delivered) {
          const nextCursor = await new Promise<string>((resolve) => {
            deliver = resolve;
          });
          delivered = true;
          return {
            cursor: nextCursor,
            messages: [{
              kind: "text",
              messageId: "9007199254740993",
              actorId,
              conversationId: actorId,
              contextToken: "context-secret",
              text: "hello",
            }],
          };
        }
        return await waitForAbort(signal);
      },
    ),
    sendText: vi.fn(async () => {}),
  };
  return {
    client,
    deliver(cursor) {
      if (deliver === undefined) {
        throw new Error("client is not polling");
      }
      deliver(cursor);
    },
  };
}

function imageBatch(cursor: string) {
  return {
    cursor,
    messages: [{
      kind: "image" as const,
      messageId: "9007199254740993",
      actorId,
      conversationId: actorId,
      contextToken: "context-secret",
      images: [{
        fullUrl:
          "https://novac2c.cdn.weixin.qq.com/c2c/download?private",
        imageAesKey: "00112233445566778899aabbccddeeff",
      }],
    }],
  };
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      reject(new WeixinProtocolError("aborted", "aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function cursorStoreFixture(
  onSet?: (cursor: string) => void,
): WeixinUpdatesCursorStore & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async (_accountId: string, cursor: string) => {
      onSet?.(cursor);
    }),
    remove: vi.fn(async () => {}),
  };
}

function accessFixture(
  allowed: boolean,
  events?: string[],
): SurfaceAccessPolicy & {
  isAllowed: ReturnType<typeof vi.fn>;
} {
  return {
    isAllowed: vi.fn(() => {
      events?.push("access");
      return allowed;
    }),
  };
}

function actorRegistryFixture(
  events?: string[],
): ConversationActorRegistry & {
  rememberActor: ReturnType<typeof vi.fn>;
} {
  return {
    actors: vi.fn(() => []),
    rememberActor: vi.fn(() => {
      events?.push("actor");
    }),
  };
}

function serviceFixture(
  implementation: (
    target: ConversationTarget,
    text: string,
  ) => ReturnType<ConversationTurnUseCases["submit"]> = async () => ({
    threadId: "thread",
    turnId: "turn",
    steered: false,
  }),
): Pick<ConversationTurnUseCases, "submit"> & {
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    submit: vi.fn(implementation),
  };
}

function outboxFixture() {
  return {
    notifyText: vi.fn(() => true),
  };
}

it.each([false, true])("preserves the latest encrypted context across admission failure and replay (Gateway restart: %s)", async restart => {
  const { DeliveryJournal } = await import("../src/surfaces/delivery-journal.js");
  const { EncryptedFileWeixinReplyContextPersistence } = await import("../src/surfaces/weixin/reply-context-persistence.js");
  const directory = mkdtempSync(join(tmpdir(), "weixin-order-regression-"));
  let journal = new DeliveryJournal(join(directory, "journal"));
  const persistence = new EncryptedFileWeixinReplyContextPersistence(join(directory, "contexts"));
  const writes = vi.spyOn(persistence, "set");
  const originalAccept = journal.accept.bind(journal);
  let refuse = true;
  vi.spyOn(journal, "accept").mockImplementation((input, purpose) => {
    if (!input.control && refuse) { refuse = false; throw new Error("temporary admission failure"); }
    return originalAccept(input, purpose);
  });
  const older = { kind: "text" as const, messageId: "older", actorId, conversationId: actorId, contextToken: "older-context", text: "ordinary" };
  const newer = { ...older, messageId: "newer", contextToken: "newer-context", text: "/stop" };
  let contexts = new WeixinReplyContextStore(accountId);
  const service = serviceFixture();
  const fatal = vi.fn();
  let fetches = 0;
  const create = (recoverOnly = false) => new WeixinInputAdapter({
    journal, accountId, replyContexts: contexts, service, access: accessFixture(true), onFatal: fatal,
    client: { getUpdates: async (_cursor, signal) => {
      if (!recoverOnly && ++fetches <= 2) return { cursor: "same-batch", messages: [older, newer] };
      return waitForAbort(signal);
    }, sendText: vi.fn(async () => {}) },
    cursorStore: cursorStoreFixture(),
    outbox: { ...outboxFixture(), trackInput: async (_id, operation) => operation() },
    persistReplyContext: (t, actor, token) => persistence.set(t, actor, token),
    readReplyContext: t => persistence.get(t),
    interactions: { handleText: async (_t, _actor, text) => text === "/stop" ? "handled" : "not-command" },
  });
  let adapter = create();
  try {
    await adapter.start();
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(journal.usage().records).toBe(0));
    expect((await persistence.get(target))?.contextToken).toBe("newer-context");
    if (restart) {
      await adapter.stop();
      journal.accept({ id: "weixin-pending-old", stream: `weixin:${accountId}:input`, lane: JSON.stringify(["weixin", accountId, actorId]), control: false, payload: { message: older, sequence: 1 } });
      journal.close();
      journal = new DeliveryJournal(join(directory, "journal"));
      contexts = new WeixinReplyContextStore(accountId);
      adapter = create(true);
    }
    await adapter.start();
    await vi.waitFor(() => expect(service.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(journal.usage().records).toBe(0));
    expect(contexts.get(target)?.contextToken).toBe("newer-context");
    expect((await persistence.get(target))?.contextToken).toBe("newer-context");
    expect(writes).toHaveBeenCalledOnce();
  } finally { await adapter.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("does not admit or acknowledge input when its ingress context cannot be persisted", async () => {
  const { DeliveryJournal } = await import("../src/surfaces/delivery-journal.js");
  const directory = mkdtempSync(join(tmpdir(), "weixin-context-failure-"));
  const journal = new DeliveryJournal(directory);
  const service = serviceFixture();
  const cursorStore = cursorStoreFixture();
  const contexts = new WeixinReplyContextStore(accountId);
  const fatal = vi.fn();
  const adapter = new WeixinInputAdapter({ journal, accountId, service, cursorStore, replyContexts: contexts,
    client: { getUpdates: async () => ({ cursor: "next", messages: [{ kind: "text", messageId: "1", actorId, conversationId: actorId, contextToken: "context", text: "/stop" }] }), sendText: vi.fn(async () => {}) },
    outbox: { ...outboxFixture(), trackInput: async (_id, operation) => operation() },
    access: accessFixture(true), onFatal: fatal,
    persistReplyContext: async () => { throw new Error("disk failure"); }, readReplyContext: async () => null,
  });
  try {
    await adapter.start(); await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(journal.usage().records).toBe(0);
    expect(cursorStore.set).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
    expect(contexts.get(target)).toBeUndefined();
  } finally { await adapter.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("cancels batch preparation without acknowledging messages or installing a late context", async () => {
  const { DeliveryJournal } = await import("../src/surfaces/delivery-journal.js");
  const directory = mkdtempSync(join(tmpdir(), "weixin-context-cancel-"));
  const journal = new DeliveryJournal(directory);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const persist = vi.fn(async () => gate);
  const cursorStore = cursorStoreFixture();
  const contexts = new WeixinReplyContextStore(accountId);
  const adapter = new WeixinInputAdapter({ journal, accountId, service: serviceFixture(), cursorStore, replyContexts: contexts,
    client: { getUpdates: async () => ({ cursor: "next", messages: [{ kind: "text", messageId: "1", actorId, conversationId: actorId, contextToken: "context", text: "ordinary" }] }), sendText: vi.fn(async () => {}) },
    outbox: { ...outboxFixture(), trackInput: async (_id, operation) => operation() },
    access: accessFixture(true), onFatal: vi.fn(), persistReplyContext: persist, readReplyContext: async () => null,
  });
  try {
    await adapter.start(); await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    const closing = adapter.stop(); release(); await closing;
    expect(journal.usage().records).toBe(0);
    expect(cursorStore.set).not.toHaveBeenCalled();
    expect(contexts.get(target)).toBeUndefined();
  } finally { release(); await adapter.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("a delayed recovery read cannot replace the context installed by a newer incoming batch", async () => {
  const { DeliveryJournal } = await import("../src/surfaces/delivery-journal.js");
  const directory = mkdtempSync(join(tmpdir(), "weixin-context-race-"));
  const journal = new DeliveryJournal(directory);
  const older = { kind: "text" as const, messageId: "old", actorId, conversationId: actorId, contextToken: "old-context", text: "older" };
  journal.accept({ id: "old", stream: `weixin:${accountId}:input`, lane: JSON.stringify(["weixin", accountId, actorId]), control: false, payload: { message: older, sequence: 1 } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const contexts = new WeixinReplyContextStore(accountId);
  const service = serviceFixture();
  let delivered = false;
  const adapter = new WeixinInputAdapter({ journal, accountId, service, cursorStore: cursorStoreFixture(), replyContexts: contexts,
    client: { getUpdates: async (_cursor, signal) => {
      if (delivered) return waitForAbort(signal);
      delivered = true; return { cursor: "next", messages: [{ ...older, messageId: "new", contextToken: "new-context", text: "newer" }] };
    }, sendText: vi.fn(async () => {}) },
    outbox: { ...outboxFixture(), trackInput: async (_id, operation) => operation() },
    access: accessFixture(true), onFatal: vi.fn(), persistReplyContext: async () => {},
    readReplyContext: async () => { await gate; return { actorId, contextToken: "old-context" }; },
  });
  try {
    await adapter.start(); await vi.waitFor(() => expect(contexts.get(target)?.contextToken).toBe("new-context"));
    release(); await vi.waitFor(() => expect(service.submit).toHaveBeenCalledTimes(2));
    expect(contexts.get(target)?.contextToken).toBe("new-context");
  } finally { release(); await adapter.stop(); journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
