import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../src/policy/index.js";
import {
  WeixinInputAdapter,
  WeixinInputFatalError,
  WeixinProtocolError,
  WeixinReplyContextStore,
  type WeixinProtocolClient,
  type WeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target: ConversationTarget = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
};

describe("WeixinInputAdapter", () => {
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
    expect(service.submit).toHaveBeenCalledWith(target, "hello");
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

    expect(service.submit).toHaveBeenCalledWith(target, "1");
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
      status: vi.fn(() => ({
        workspaceId: "main",
        workspaceName: "Main",
        cwd: "/workspace",
        threadId: "thread",
        turnId: null,
        model: "gpt-test",
        effort: "medium",
        serviceTier: null,
        modelPending: false,
        effortPending: false,
        fastModePending: false,
        collaborationMode: "default",
        collaborationModePending: false,
      })),
    } as unknown as ConversationService;
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

  it("resolves an authorized user quote from the bounded process cache", async () => {
    let delivered = false;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        if (!delivered) {
          delivered = true;
          return {
            cursor: "cursor-quote",
            messages: [
              {
                kind: "text" as const,
                messageId: "100",
                actorId,
                conversationId: actorId,
                contextToken: "context-original",
                text: "原始用户消息",
              },
              {
                kind: "text" as const,
                messageId: "101",
                actorId,
                conversationId: actorId,
                contextToken: "context-reply",
                text: "引用测试",
                quotedMessageId: "100",
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
      "原始用户消息",
    );
    expect(service.submit).toHaveBeenNthCalledWith(
      2,
      target,
      "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：\n> 原始用户消息\n\n当前消息：\n引用测试",
    );
  });

  it("processes only the current text when a Weixin quote cache misses", async () => {
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
      "重启后的引用测试",
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
      "当前已授权消息",
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
          path: "/private/weixin/first.png",
          mimeType: "image/png" as const,
          bytes: 8,
        })
        .mockResolvedValueOnce({
          path: "/private/weixin/second.jpg",
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
      localImages: [
        { path: "/private/weixin/first.png" },
        { path: "/private/weixin/second.jpg" },
      ],
    });
  });

  it("coalesces separate image messages and persists reply contexts in order", async () => {
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
          path: "/private/weixin/first.png",
          mimeType: "image/png" as const,
          bytes: 8,
        })
        .mockResolvedValueOnce({
          path: "/private/weixin/second.jpg",
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
    expect(service.submit).toHaveBeenCalledTimes(1);
    expect(service.submit).toHaveBeenCalledWith(target, {
      text: "比较这些图片",
      localImages: [
        { path: "/private/weixin/first.png" },
        { path: "/private/weixin/second.jpg" },
      ],
    });
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
      expect.stringContaining("{\"enabled\":true}"),
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
  ) => ReturnType<ConversationService["submit"]> = async () => ({
    threadId: "thread",
    turnId: "turn",
    steered: false,
  }),
): ConversationService & {
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    submit: vi.fn(implementation),
  } as unknown as ConversationService & {
    submit: ReturnType<typeof vi.fn>;
  };
}

function outboxFixture() {
  return {
    notifyText: vi.fn(() => true),
  };
}
