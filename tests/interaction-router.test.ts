import { describe, expect, it, vi } from "vitest";

import {
  InteractionRouter,
  safeInteractionDecision,
} from "../src/approval/interaction-router.js";
import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "../src/approval/types.js";
import type { ConversationTarget } from "../src/conversation-core/events.js";
import { approvalTarget as target, FakeInteraction } from "./approval-test-fixture.js";

class ControlledInteraction implements InteractionPort {
  requests: InteractionRequest[] = [];
  private readonly pending: Array<{
    request: InteractionRequest;
    resolve(decision: InteractionDecision): void;
  }> = [];

  request(
    _target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.pending.push({ request, resolve });
    });
  }

  resolveNext(decision: InteractionDecision): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("没有等待处理的交互");
    }
    pending.resolve(decision);
  }

  cancelAll(): void {
    for (const pending of this.pending.splice(0)) {
      pending.resolve(safeInteractionDecision(pending.request));
    }
  }
}

describe("InteractionRouter", () => {
  it("removes a whole cancellation batch before dispatching unaffected queued work", async () => {
    const port = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", port);
    const decisions = ["first", "second", "third"].map((requestId) => router.request(
      target, approvalInteractionRequest({ requestId }),
    ));
    const unaffected = router.request(target, approvalInteractionRequest({
      requestId: "unaffected", threadId: "other-thread",
    }));

    router.cancelThreads(new Set(["thread-1"]));

    expect(port.requests.map((request) => request.requestId)).toEqual(["first", "unaffected"]);
    await expect(Promise.all(decisions)).resolves.toEqual(Array(3).fill({ type: "approval", approved: false }));
    port.resolveNext({ type: "approval", approved: true, scope: "once" });
    await Promise.resolve();
    expect(router.hasPendingForThread("other-thread")).toBe(true);
    port.resolveNext({ type: "approval", approved: true, scope: "once" });
    await expect(unaffected).resolves.toMatchObject({ approved: true });
  });

  it.each(["resolved", "cancelAll", "unregister"] as const)(
    "settles active requests on %s even if Surface cleanup throws, ignoring late approval",
    async (operation) => {
      const port = new ControlledInteraction();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const router = new InteractionRouter(logger);
      const unregister = router.register("telegram", "default", port);
      const brokenCleanup = () => { throw new Error("private upstream detail"); };
      Object.assign(port, { resolved: brokenCleanup, cancelAll: brokenCleanup });
      const decision = router.request(target, approvalInteractionRequest());
      if (operation === "resolved") router.resolved("request-choice");
      else if (operation === "cancelAll") router.cancelAll();
      else unregister();

      expect(router.hasPendingForThread("thread-1")).toBe(false);
      await expect(decision).resolves.toEqual({ type: "approval", approved: false });
      port.resolveNext({ type: "approval", approved: true, scope: "session" });
      await expect(decision).resolves.toEqual({ type: "approval", approved: false });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private upstream detail");
    },
  );

  it("isolates cancellation cleanup failures across accounts and remains reusable", async () => {
    const router = new InteractionRouter();
    const first = new ControlledInteraction();
    const second = new ControlledInteraction();
    first.cancelAll = () => { throw new Error("cleanup failed"); };
    router.register("telegram", "default", first);
    router.register("feishu", "default", second);
    const decisions = [
      router.request(target, approvalInteractionRequest({ requestId: "one" })),
      router.request({ ...target, surface: "feishu" }, approvalInteractionRequest({ requestId: "two" })),
    ];
    const cancelled = vi.spyOn(second, "cancelAll");
    router.cancelAll();
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(Promise.all(decisions)).resolves.toEqual(Array(2).fill({ type: "approval", approved: false }));
    const next = router.request(target, approvalInteractionRequest({ requestId: "new" }));
    first.resolveNext({ type: "approval", approved: true, scope: "once" });
    await Promise.resolve();
    expect(router.hasPendingForThread("thread-1")).toBe(true);
    first.resolveNext({ type: "approval", approved: false });
    await next;
  });

  it("releases the queue after a Surface request throws synchronously", async () => {
    const router = new InteractionRouter();
    const request = vi.fn<InteractionPort["request"]>()
      .mockImplementationOnce(() => { throw new Error("send failed"); })
      .mockResolvedValue({ type: "approval", approved: false });
    router.register("telegram", "default", { request });
    await expect(router.request(target, approvalInteractionRequest())).rejects.toThrow("send failed");
    expect(router.hasPendingForThread("thread-1")).toBe(false);
    await expect(router.request(target, approvalInteractionRequest())).resolves.toEqual({ type: "approval", approved: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a replacement request with the same ID when the old Surface finishes late", async () => {
    const router = new InteractionRouter();
    const port = new ControlledInteraction();
    router.register("telegram", "default", port);
    const request = approvalInteractionRequest();
    const old = router.request(target, request);
    router.cancelThreads(new Set([request.threadId]));
    await old;
    const replacement = router.request(target, request);
    port.resolveNext({ type: "approval", approved: true, scope: "session" });
    await Promise.resolve();
    expect(router.hasPendingForThread(request.threadId)).toBe(true);
    port.resolveNext({ type: "approval", approved: false });
    await expect(replacement).resolves.toEqual({ type: "approval", approved: false });
  });

  it("does not queue blocking approvals behind optional async questions", async () => {
    const port = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", port);
    const question: InteractionRequest = {
      type: "user-input", asynchronous: true, requestId: "async-1", threadId: "thread-1",
      turnId: "turn-1", itemId: "item-1", title: "Question", expiresInMs: 1_000,
      questions: [{ id: "q1", header: "Question", question: "Pick", options: [], allowOther: true, secret: false }],
    };
    const optional = router.request(target, question);
    const approval = router.request(target, approvalInteractionRequest());
    expect(port.requests.map((request) => request.type)).toEqual(["user-input", "approval"]);
    port.cancelAll();
    await Promise.all([optional, approval]);
  });
  it("reports pending interactions for the exact Thread until they resolve", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", interaction);
    const request = approvalInteractionRequest({
      requestId: "request-thread",
      threadId: "thread-pending",
    });

    const decision = router.request(target, request);

    expect(router.hasPendingForThread("thread-pending")).toBe(true);
    expect(router.hasPendingForThread("thread-other")).toBe(false);
    interaction.resolveNext({ type: "approval", approved: false });
    await decision;
    expect(router.hasPendingForThread("thread-pending")).toBe(false);
  });

  it("cancels only interactions owned by disconnected Provider Threads", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", interaction);
    const affected = router.request(target, approvalInteractionRequest({
      requestId: "request-deepseek",
      threadId: "thread-deepseek",
    }));
    const unaffectedTarget = { ...target, conversationId: "200" };
    const unaffected = router.request(unaffectedTarget, approvalInteractionRequest({
      requestId: "request-openai",
      threadId: "thread-openai",
    }));

    router.cancelThreads(new Set(["thread-deepseek"]));

    await expect(affected).resolves.toEqual({ type: "approval", approved: false });
    expect(router.hasPendingForThread("thread-deepseek")).toBe(false);
    expect(router.hasPendingForThread("thread-openai")).toBe(true);
    interaction.resolveNext({ type: "approval", approved: false });
    interaction.resolveNext({ type: "approval", approved: true, scope: "once" });
    await expect(unaffected).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "once",
    });
  });

  it("delivers only one interaction at a time within the same Conversation", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", interaction);
    const firstRequest = approvalInteractionRequest({
      requestId: "request-first",
    });
    const secondRequest = approvalInteractionRequest({
      requestId: "request-second",
    });

    const first = router.request(target, firstRequest);
    const second = router.request(target, secondRequest);

    expect(interaction.requests).toEqual([firstRequest]);
    interaction.resolveNext({
      type: "approval",
      approved: true,
      scope: "once",
    });
    await expect(first).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "once",
    });
    expect(interaction.requests).toEqual([firstRequest, secondRequest]);

    interaction.resolveNext({ type: "approval", approved: false });
    await expect(second).resolves.toEqual({
      type: "approval",
      approved: false,
    });
  });

  it("does not deliver a queued interaction after another client resolves it", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("feishu", "default", interaction);
    const feishuTarget: ConversationTarget = {
      surface: "feishu",
      accountId: "default",
      conversationId: "chat-1",
    };
    const firstRequest = approvalInteractionRequest({
      requestId: "request-first",
    });
    const secondRequest = approvalInteractionRequest({
      requestId: "request-second",
    });
    const first = router.request(feishuTarget, firstRequest);
    const second = router.request(feishuTarget, secondRequest);
    let secondDecision: InteractionDecision | undefined;
    void second.then((decision) => {
      secondDecision = decision;
    });

    router.resolved("request-second");
    await Promise.resolve();

    expect(secondDecision).toEqual({
      type: "approval",
      approved: false,
    });
    interaction.resolveNext({
      type: "approval",
      approved: true,
      scope: "once",
    });
    await first;
    await second;
    expect(interaction.requests).toEqual([firstRequest]);
  });

  it("cancels queued interactions without delivering them when the Gateway closes", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("weixin", "default", interaction);
    const weixinTarget: ConversationTarget = {
      surface: "weixin",
      accountId: "default",
      conversationId: "user-1",
    };
    const firstRequest = approvalInteractionRequest({
      requestId: "request-first",
    });
    const secondRequest = approvalInteractionRequest({
      requestId: "request-second",
    });
    const first = router.request(weixinTarget, firstRequest);
    const second = router.request(weixinTarget, secondRequest);
    let secondDecision: InteractionDecision | undefined;
    void second.then((decision) => {
      secondDecision = decision;
    });

    router.cancelAll("Gateway 已停止");
    await Promise.resolve();

    expect(secondDecision).toEqual({
      type: "approval",
      approved: false,
    });
    await first;
    await second;
    expect(interaction.requests).toEqual([firstRequest]);
  });

  it("fails closed and cancels only the unavailable Surface account", async () => {
    const telegram = new ControlledInteraction();
    const feishu = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", telegram);
    router.register("feishu", "tenant-a", feishu);
    const telegramRequest = approvalInteractionRequest({
      requestId: "request-telegram",
    });
    const queuedTelegramRequest = approvalInteractionRequest({
      requestId: "request-telegram-queued",
    });
    const feishuRequest = approvalInteractionRequest({
      requestId: "request-feishu",
    });
    const telegramDecision = router.request(target, telegramRequest);
    const queuedTelegramDecision = router.request(
      target,
      queuedTelegramRequest,
    );
    const feishuDecision = router.request({
      surface: "feishu",
      accountId: "tenant-a",
      conversationId: "chat-feishu",
    }, feishuRequest);

    router.setAvailable(
      "telegram",
      "default",
      false,
      "渠道连接已中断",
    );

    await expect(telegramDecision).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await expect(queuedTelegramDecision).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await expect(router.request(target, approvalInteractionRequest({
      requestId: "request-telegram-offline",
    }))).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(telegram.requests).toEqual([telegramRequest]);
    expect(feishu.requests).toEqual([feishuRequest]);

    feishu.resolveNext({ type: "approval", approved: false });
    await feishuDecision;
    router.setAvailable("telegram", "default", true);
    const recovered = router.request(target, approvalInteractionRequest({
      requestId: "request-telegram-recovered",
    }));
    expect(telegram.requests).toHaveLength(2);
    telegram.resolveNext({ type: "approval", approved: false });
    await recovered;
  });

  it("fails closed when the same request ID is already pending", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", interaction);
    const request = approvalInteractionRequest({
      requestId: "request-duplicate",
    });

    const first = router.request(target, request);
    const duplicate = router.request(target, request);

    await expect(duplicate).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(interaction.requests).toEqual([request]);

    interaction.resolveNext({ type: "approval", approved: false });
    await first;
  });

  it("fails closed when the shared interaction queue reaches its capacity", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter(undefined, 2);
    router.register("telegram", "default", interaction);
    const firstRequest = approvalInteractionRequest({
      requestId: "request-first",
    });
    const secondRequest = approvalInteractionRequest({
      requestId: "request-second",
    });
    const excessRequest = approvalInteractionRequest({
      requestId: "request-excess",
    });

    const first = router.request(target, firstRequest);
    const second = router.request(target, secondRequest);

    await expect(router.request(target, excessRequest)).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(interaction.requests).toEqual([firstRequest]);

    interaction.resolveNext({ type: "approval", approved: false });
    await first;
    await Promise.resolve();
    interaction.resolveNext({ type: "approval", approved: false });
    await second;
  });

  it("delivers interactions for different Conversations independently", async () => {
    const interaction = new ControlledInteraction();
    const router = new InteractionRouter();
    router.register("feishu", "default", interaction);
    const firstRequest = approvalInteractionRequest({
      requestId: "request-chat-1",
    });
    const secondRequest = approvalInteractionRequest({
      requestId: "request-chat-2",
    });

    const first = router.request({
      surface: "feishu",
      accountId: "default",
      conversationId: "chat-1",
    }, firstRequest);
    const second = router.request({
      surface: "feishu",
      accountId: "default",
      conversationId: "chat-2",
    }, secondRequest);

    expect(interaction.requests).toEqual([firstRequest, secondRequest]);
    interaction.resolveNext({ type: "approval", approved: false });
    interaction.resolveNext({ type: "approval", approved: false });
    await Promise.all([first, second]);
  });

  it("provides the shared fail-closed decision for every interaction type", () => {
    expect(safeInteractionDecision({
      type: "approval",
      requestId: "request-approval",
      kind: "command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      title: "审批",
      detail: "npm test",
      allowSession: false,
      expiresInMs: 30_000,
    })).toEqual({ type: "approval", approved: false });
    expect(safeInteractionDecision({
      type: "user-input",
      requestId: "request-input",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      title: "补充信息",
      questions: [],
      expiresInMs: 30_000,
    })).toEqual({ type: "user-input", answers: {} });
    expect(safeInteractionDecision({
      type: "elicitation",
      requestId: "request-elicitation",
      threadId: "thread-1",
      turnId: null,
      title: "MCP 输入",
      message: "确认",
      mode: "form",
      expiresInMs: 30_000,
    })).toEqual({
      type: "elicitation",
      action: "cancel",
      content: null,
    });
  });

  it("routes requests by Surface and account without cross-delivery", async () => {
    const telegram = new FakeInteraction();
    const feishu = new FakeInteraction();
    const router = new InteractionRouter();
    router.register("telegram", "default", telegram);
    router.register("feishu", "tenant-a", feishu);
    const request: InteractionRequest = {
      type: "approval",
      requestId: "request-route",
      kind: "command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      title: "审批",
      detail: "npm test",
      allowSession: true,
      expiresInMs: 30_000,
    };

    await router.request(
      { surface: "feishu", accountId: "tenant-a", conversationId: "chat-1" },
      request,
    );

    expect(feishu.requests).toEqual([request]);
    expect(telegram.requests).toEqual([]);
  });

  it("fails closed for an unregistered Surface account and broadcasts invalidation", async () => {
    const telegram = new FakeInteraction();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const router = new InteractionRouter(logger);
    router.register("telegram", "default", telegram);
    const request: InteractionRequest = {
      type: "approval",
      requestId: "request-missing",
      kind: "file",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      title: "审批",
      detail: "修改文件",
      allowSession: true,
      expiresInMs: 30_000,
    };

    await expect(router.request(
      { surface: "wechat", accountId: "corp-a", conversationId: "chat-1" },
      request,
    )).resolves.toEqual({ type: "approval", approved: false });
    router.resolved("request-resolved");
    router.cancelAll("连接已断开");

    expect(telegram.resolvedIds).toEqual(["request-resolved"]);
    expect(telegram.cancelledOutcomes).toEqual(["连接已断开"]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        requestId: "request-missing",
        requestType: "approval",
        threadId: "thread-1",
        turnId: "turn-1",
        surface: "wechat",
        accountId: "corp-a",
        conversationId: "chat-1",
        reason: "unregistered-surface-account",
      },
      "Codex 交互请求没有已注册的 Surface 端口，已安全拒绝",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("修改文件");
  });
});

function approvalInteractionRequest(
  overrides: Partial<Extract<InteractionRequest, { type: "approval" }>> = {},
): Extract<InteractionRequest, { type: "approval" }> {
  return {
    type: "approval",
    requestId: "request-choice",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "审批",
    detail: "npm test",
    allowSession: true,
    execPolicyAmendment: ["git", "commit"],
    networkApprovalContext: {
      host: "api.example.com",
      protocol: "https",
    },
    networkPolicyAmendments: [
      { host: "api.example.com", action: "allow" },
      { host: "api.example.com", action: "deny" },
    ],
    expiresInMs: 30_000,
    ...overrides,
  };
}
