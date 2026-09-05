import pino from "pino";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationUseCases,
  ScheduledTaskConfirmation,
  ScheduledTaskUseCases,
} from "../src/application/index.js";
import type {
  OutputEvent,
} from "../src/conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../src/policy/index.js";
import type { SurfaceAdapter } from "../src/surfaces/index.js";
import {
  createWeixinSurface,
  type CreateWeixinSurfaceOptions,
  WeixinConfigurationDeliveryError,
  WeixinProtocolError,
  WeixinSurface,
  type WeixinProtocolClient,
  type WeixinLifecycleProtocolClient,
  type WeixinReplyContextPersistence,
  type WeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";

const accountId = "account-fixture@im.bot";
const actorId = "actor-fixture@im.wechat";
const target = {
  surface: "weixin",
  accountId,
  conversationId: actorId,
} as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WeixinSurface", () => {
  it("passes the OpenCode Go usage lookup through the surface factory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-weixin-opencode-"));
    temporaryDirectories.push(directory);
    for (const name of ["credentials", "reply", "cursor", "uploads"]) {
      mkdirSync(join(directory, name), { recursive: true });
    }
    const requestStartedAtMs = Date.parse("2026-08-17T03:30:00.000Z");
    const remainingUsage = vi.fn<NonNullable<CreateWeixinSurfaceOptions["remainingUsage"]>>(async () => ({
      model: "deepseek-v4-flash",
      bucket: "peak",
      includedUsageUsd: 15,
      usedUsdNanos: 2_813_173_642,
      usedPercent: 2_813_173_642 / 15_000_000_000 * 100,
      remainingUsdNanos: 12_186_826_358,
      windowStartAtMs: 1_786_803_727_000,
      windowEndAtMs: 1_789_482_127_000,
    }));
    const surface = createWeixinSurface({
      accountId,
      service: serviceFixture(),
      access: accessFixture(true),
      actorRegistry: actorRegistryFixture(),
      credentialDirectory: join(directory, "credentials"),
      replyContextDirectory: join(directory, "reply"),
      cursorDirectory: join(directory, "cursor"),
      uploadsDirectory: join(directory, "uploads"),
      startupNotification: { targets: () => [], text: () => "" },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
      remainingUsage,
    });

    await surface.output.handle({
      type: "turn.completed",
      target,
      threadId: "thread",
      turnId: "turn",
      status: "completed",
      model: "deepseek-v4-flash",
      modelProvider: "opencode-go",
      timing: {
        modelRequestCount: 1,
        modelRequestStartedAtMs: requestStartedAtMs,
      },
    });
    expect(remainingUsage).toHaveBeenCalledWith(
      "deepseek-v4-flash",
      requestStartedAtMs,
      "opencode-go",
    );
    await surface.stop();
  });

  it("forms an authorized inbound-to-final-output text loop", async () => {
    const cursorStore = cursorStoreFixture();
    const service = serviceFixture();
    const actorRegistry = actorRegistryFixture();
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    let pollCount = 0;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch();
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const onFatal = vi.fn();
    const replyContextPersistence = replyContextPersistenceFixture();
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore,
      service,
      access: accessFixture(true),
      actorRegistry,
      replyContextPersistence,
      logger: pino({ level: "silent" }),
      onFatal,
    });
    const adapter: SurfaceAdapter = surface;

    expect(adapter.surface).toBe("weixin");
    expect(adapter.accountId).toBe(accountId);
    await surface.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
    });

    surface.output.handle(finalText("final reply"));
    surface.output.handle(turnCompleted());
    await surface.stop();

    expect(service.submit).toHaveBeenCalledWith(target, "hello");
    expect(actorRegistry.rememberActor).toHaveBeenCalledWith(target, actorId);
    expect(replyContextPersistence.set).toHaveBeenCalledWith(
      target,
      actorId,
      "context-secret",
    );
    expect(sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "final reply",
      "**本次运行 · 已完成**\n\n- Session：测试会话\n- Session ID：thread",
    ]);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("passes scheduled tasks through the surface to the text confirmation command", async () => {
    const token = "12345678-1234-1234-1234-123456789abc";
    let pollCount = 0;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch(`/schedule confirm ${token}`);
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const confirm = vi.fn(() => ({
      action: "created" as const,
      task: scheduledTaskView(),
    }));
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      scheduledTasks: { confirm } as unknown as ScheduledTaskUseCases,
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(confirm).toHaveBeenCalledWith(target, actorId, token);
    });
    await vi.waitFor(() => {
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("已创建 Gateway 计划任务"),
      }), expect.any(AbortSignal));
    });
    await surface.stop();
  });

  it("presents a complete schedule_task preview as native Weixin text", async () => {
    let pollCount = 0;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch("建立计划任务上下文");
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });
    const preview: ScheduledTaskConfirmation = {
      action: "create",
      token: "12345678-1234-1234-1234-123456789abc",
      expiresAt: Date.now() + 60_000,
      task: scheduledTaskView(),
    };

    await surface.start();
    await vi.waitFor(() => {
      expect(surface.output).toBeDefined();
    });
    await surface.presentScheduledTaskConfirmation(target, actorId, preview);

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/Workspace：main[\s\S]*模型：opencode-go\/deepseek-v4-flash-vision-exp[\s\S]*思考等级：high[\s\S]*\/schedule confirm 12345678-1234-1234-1234-123456789abc/u),
    }), expect.any(AbortSignal));
    await surface.stop();
  });

  it("keeps an exact approval command in one message through the live input loop", async () => {
    let releaseApproval!: (text: string) => void;
    const approvalText = new Promise<string>((resolve) => {
      releaseApproval = resolve;
    });
    let pollCount = 0;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch("建立审批上下文");
        }
        if (pollCount === 2) {
          const text = await approvalText;
          return {
            cursor: "cursor-two",
            messages: [{
              kind: "text" as const,
              messageId: "approval-message",
              actorId,
              conversationId: actorId,
              contextToken: "context-secret",
              text,
            }],
          };
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const actorRegistry = actorRegistryFixture([actorId]);
    const service = serviceFixture();
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service,
      access: accessFixture(true),
      actorRegistry,
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(service.submit).toHaveBeenCalledWith(
        target,
        "建立审批上下文",
      );
    });
    const pending = surface.interactions.request(target, {
      type: "approval",
      requestId: "surface-request",
      kind: "command",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      title: "Codex 请求执行命令",
      detail: "x".repeat(4_000),
      allowSession: false,
      execPolicyAmendment: ["id"],
      expiresInMs: 60_000,
    });
    await vi.waitFor(() => {
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("```text\n/批准一次 "),
      }), expect.any(AbortSignal));
    });
    const choices = sendText.mock.calls
      .map(([input]) => input.text)
      .find((text) => text.includes("```text\n/批准一次 "));
    const token = choices?.match(
      /```text\n\/批准一次 ([A-Za-z0-9_-]+)\n```/u,
    )?.[1];
    expect(token).toBeDefined();
    expect(choices).toBe([
      "批准一次",
      `\`\`\`text\n/批准一次 ${token!}\n\`\`\``,
      "保存命令规则",
      `\`\`\`text\n/保存命令规则 ${token!}\n\`\`\``,
      "拒绝",
      `\`\`\`text\n/拒绝 ${token!}\n\`\`\``,
    ].join("\n\n"));
    releaseApproval(`/批准一次 ${token!}`);
    await expect(pending).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "once",
    });
    await surface.stop();
  });

  it("restores an encrypted reply context and sends the startup notification", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "Codex Connect 已上线\nApp Server：已连接",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(replyContextPersistence.get).toHaveBeenCalledWith(target);
    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "restored-context",
      text: "**Codex Connect 已上线**\n- App Server：已连接",
    }, expect.any(AbortSignal));
  });

  it("uses official lifecycle notifications without depending on reply context", async () => {
    const lifecycleClient: WeixinLifecycleProtocolClient = {
      notifyStart: vi.fn(async () => {}),
      notifyStop: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText: vi.fn(async () => {}),
      },
      lifecycleClient,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(lifecycleClient.notifyStart).toHaveBeenCalledOnce();
    expect(lifecycleClient.notifyStop).toHaveBeenCalledOnce();
  });

  it("keeps polling when an official lifecycle notification fails", async () => {
    const warn = vi.fn();
    const lifecycleClient: WeixinLifecycleProtocolClient = {
      notifyStart: vi.fn(async () => {
        throw new WeixinProtocolError(
          "api-error",
          "private upstream response",
          undefined,
          -14,
        );
      }),
      notifyStop: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText: vi.fn(async () => {}),
      },
      lifecycleClient,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: { warn } as unknown as pino.Logger,
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(warn).toHaveBeenCalledWith(
      {
        surface: "weixin",
        accountId,
        state: "start",
        errorType: "WeixinProtocolError",
        errorCode: "api-error",
        returnCode: -14,
      },
      "微信上线状态对账失败，不影响 Gateway",
    );
    expect(lifecycleClient.notifyStop).toHaveBeenCalledOnce();
  });

  it("keeps restored reply context when startup delivery reports an expired Bot Token", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -14,
          );
        }),
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "Codex Connect 已上线",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(replyContextPersistence.remove).not.toHaveBeenCalled();
  });

  it("drops a rejected restored context while polling accepts the next inbound context", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    let releaseInbound!: () => void;
    const inboundReady = new Promise<void>((resolve) => {
      releaseInbound = resolve;
    });
    let pollCount = 0;
    const getUpdates = vi.fn<WeixinProtocolClient["getUpdates"]>(
      async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          await inboundReady;
          return inboundBatch("refresh reply context");
        }
        return await waitForAbort(signal);
      },
    );
    const service = serviceFixture();
    const onFatal = vi.fn();
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates,
        sendText: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -2,
          );
        }),
      },
      cursorStore: cursorStoreFixture(),
      service,
      access: accessFixture(true),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "Codex Connect 已上线",
      },
      logger: pino({ level: "silent" }),
      onFatal,
    });

    await surface.start();

    expect(replyContextPersistence.removeIf).toHaveBeenCalledWith(
      target,
      "restored-context",
    );
    releaseInbound();
    await vi.waitFor(() => {
      expect(replyContextPersistence.set).toHaveBeenCalledWith(
        target,
        actorId,
        "context-secret",
      );
    });
    expect(service.submit).toHaveBeenCalledWith(
      target,
      "refresh reply context",
    );
    expect(onFatal).not.toHaveBeenCalled();
    await surface.stop();
  });

  it("removes a restored context instead of notifying a revoked actor", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText,
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(false),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "Codex Connect 已上线",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(replyContextPersistence.remove).toHaveBeenCalledWith(target);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("routes an inbound basic command through the shared service and reply context", async () => {
    const cursorStore = cursorStoreFixture();
    const submit = vi.fn();
    const stop = vi.fn(async () => true);
    const service = {
      submit,
      stop,
    } as unknown as ConversationUseCases;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    let pollCount = 0;
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch("/stop");
        }
        return await waitForAbort(signal);
      }),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore,
      service,
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalledWith(accountId, "cursor-one");
      expect(sendText).toHaveBeenCalledOnce();
    });
    await surface.stop();

    expect(submit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(target);
    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "context-secret",
      text: "**已请求停止当前任务。**",
    }, expect.any(AbortSignal));
  });

  it("stops input before draining output and keeps repeated lifecycle calls safe", async () => {
    const events: string[] = [];
    const cursorStore = cursorStoreFixture();
    let pollCount = 0;
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(
      async () => {
        events.push("output:start");
        await outputGate.promise;
        events.push("output:end");
      },
    );
    let releaseOutput!: () => void;
    const outputGate = {
      promise: new Promise<void>((resolve) => {
        releaseOutput = resolve;
      }),
    };
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn(async (_cursor, signal) => {
        pollCount += 1;
        if (pollCount === 1) {
          return inboundBatch();
        }
        return await waitForAbort(signal, () => {
          events.push("input:stopped");
        });
      }),
      sendText,
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore,
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.start();
    await vi.waitFor(() => {
      expect(cursorStore.set).toHaveBeenCalled();
    });
    surface.output.handle(finalText("reply"));
    await vi.waitFor(() => {
      expect(events).toContain("output:start");
    });

    const firstStop = surface.stop();
    const secondStop = surface.stop();
    expect(firstStop).toBe(secondStop);
    await vi.waitFor(() => {
      expect(events).toContain("input:stopped");
    });
    expect(events).not.toContain("output:end");

    releaseOutput();
    await firstStop;
    expect(events.indexOf("input:stopped")).toBeLessThan(
      events.indexOf("output:end"),
    );
    expect(surface.output.notifyText(target, "late")).toBe(false);
  });

  it("reports receiver failure through the constrained fatal callback", async () => {
    const onFatal = vi.fn();
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -15,
          );
        }),
        sendText: vi.fn(async () => {}),
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal,
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({
        code: "api-error",
        message: "微信消息接收已停止",
      }));
    });
    expect(
      (onFatal.mock.calls[0]?.[0] as Error).message,
    ).not.toContain("private");
    await surface.stop();
  });

  it("logs a stale credential pause without stopping the Gateway", async () => {
    const onFatal = vi.fn();
    const warn = vi.fn();
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn(async () => {
          throw new WeixinProtocolError(
            "api-error",
            "private upstream response",
            undefined,
            -14,
          );
        }),
        sendText: vi.fn(async () => {}),
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: { warn } as unknown as pino.Logger,
      onFatal,
    });

    await surface.start();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        {
          surface: "weixin",
          accountId,
          attempt: 1,
          code: "api-error",
          delayMs: 3_600_000,
          phase: "credential-pause",
          returnCode: -14,
        },
        "微信 Bot Token 已失效，已暂停轮询；请重新运行 codexc setup",
      );
    });
    expect(onFatal).not.toHaveBeenCalled();
    await surface.stop();
  });

  it("delivers a persistent configuration change through a restored reply context", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText,
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await expect(surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{
        id: "docs",
        name: "Docs",
        cwd: "/workspace/docs",
      }],
    })).resolves.toBeUndefined();
    await surface.stop();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "restored-context",
      text: [
        "**Workspace 已添加**",
        "",
        "- Docs · docs",
        "- 工作目录：/workspace/docs",
        "",
        "- 发送 /workspace 可查看并切换 Workspace。",
        "",
        "- 已生效：Workspace",
      ].join("\n"),
    }, expect.any(AbortSignal));
  });

  it("queues a runtime configuration change through a restored reply context", async () => {
    const replyContextPersistence = replyContextPersistenceFixture({
      version: 1,
      accountId,
      actorId,
      contextToken: "restored-context",
      updatedAt: 1_000,
    });
    const sendText = vi.fn<WeixinProtocolClient["sendText"]>(async () => {});
    const surface = new WeixinSurface({
      accountId,
      client: {
        getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
        sendText,
      },
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      replyContextPersistence,
      startupNotification: {
        targets: () => [target],
        text: () => "",
      },
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });
    const adapter: SurfaceAdapter = surface;

    await surface.start();
    adapter.configurationChanged?.({
      action: "restarting",
      changes: [{ code: "codex.default-model", scope: "global" }],
      addedWorkspaces: [],
    });
    await surface.stop();

    expect(sendText).toHaveBeenCalledWith({
      actorId,
      contextToken: "restored-context",
      text: [
        "**Gateway 配置需要重启**",
        "- 变更：默认模型",
        "- 当前 Gateway 将退出；若由系统服务托管，将自动重新启动。",
      ].join("\n"),
    }, expect.any(AbortSignal));
  });

  it("fails proactive configuration delivery closed without a reply context provider", async () => {
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await expect(surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [],
      addedWorkspaces: [],
    })).rejects.toBeInstanceOf(WeixinConfigurationDeliveryError);
    expect(client.sendText).not.toHaveBeenCalled();
    await surface.stop();
  });

  it("cannot restart after an idempotent stop-before-start", async () => {
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.stop();
    await expect(surface.stop()).resolves.toBeUndefined();
    await expect(surface.start()).rejects.toThrow(
      "微信输入 Adapter 已停止",
    );
    expect(client.getUpdates).not.toHaveBeenCalled();
  });

  it("starts the image store before input and closes it with the Surface", async () => {
    const images = {
      start: vi.fn(async () => {}),
      close: vi.fn(),
      download: vi.fn(),
    };
    const client: WeixinProtocolClient = {
      getUpdates: vi.fn((_cursor, signal) => waitForAbort(signal)),
      sendText: vi.fn(async () => {}),
    };
    const surface = new WeixinSurface({
      accountId,
      client,
      cursorStore: cursorStoreFixture(),
      service: serviceFixture(),
      access: accessFixture(true),
      images,
      logger: pino({ level: "silent" }),
      onFatal: vi.fn(),
    });

    await surface.start();
    await surface.stop();

    expect(images.start).toHaveBeenCalledOnce();
    expect(images.close).toHaveBeenCalledOnce();
  });
});

function inboundBatch(text = "hello") {
  return {
    cursor: "cursor-one",
    messages: [{
      kind: "text" as const,
      messageId: "9007199254740993",
      actorId,
      conversationId: actorId,
      contextToken: "context-secret",
      text,
    }],
  };
}

function finalText(
  text: string,
): Extract<OutputEvent, { type: "text.completed" }> {
  return {
    type: "text.completed",
    target,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    phase: "final_answer",
    text,
  };
}

function turnCompleted(): Extract<OutputEvent, { type: "turn.completed" }> {
  return {
    type: "turn.completed",
    target,
    threadId: "thread",
    sessionName: "测试会话",
    turnId: "turn",
    status: "completed",
  };
}

function scheduledTaskView() {
  return {
    taskId: "task-1",
    name: "提醒我：收到",
    status: "active" as const,
    schedule: { type: "once" as const, date: "2026-08-24", time: "10:31" },
    timezone: "Asia/Shanghai",
    nextRunAt: Date.parse("2026-08-24T02:31:00.000Z"),
    workspaceId: "main",
    modelProvider: "opencode-go",
    model: "deepseek-v4-flash-vision-exp",
    reasoningEffort: "high",
    serviceTier: null,
    sandbox: "workspace-write" as const,
    permissions: null,
    promptPreview: "提醒我：收到",
  };
}

function waitForAbort(
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(new WeixinProtocolError("aborted", "aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function cursorStoreFixture(): WeixinUpdatesCursorStore & {
  set: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

function serviceFixture(): ConversationUseCases & {
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    submit: vi.fn(async () => ({
      threadId: "thread",
      turnId: "turn",
      steered: false,
    })),
  } as unknown as ConversationUseCases & {
    submit: ReturnType<typeof vi.fn>;
  };
}

function actorRegistryFixture(
  actors: string[] = [],
): ConversationActorRegistry & {
  rememberActor: ReturnType<typeof vi.fn>;
} {
  return {
    actors: vi.fn(() => actors),
    rememberActor: vi.fn<ConversationActorRegistry["rememberActor"]>(),
  };
}

function accessFixture(allowed: boolean): SurfaceAccessPolicy {
  return {
    isAllowed: vi.fn(() => allowed),
  };
}

function replyContextPersistenceFixture(
  restored: Awaited<
    ReturnType<WeixinReplyContextPersistence["get"]>
  > = null,
): WeixinReplyContextPersistence & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  removeIf: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => restored),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    removeIf: vi.fn(async () => true),
  };
}
