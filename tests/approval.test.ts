import { describe, expect, it, vi } from "vitest";

import { ApprovalCoordinator } from "../src/approval/coordinator.js";
import {
  resolveApprovalChoice,
  type ApprovalChoice,
} from "../src/approval/index.js";
import {
  InteractionRouter,
  safeInteractionDecision,
} from "../src/approval/interaction-router.js";
import type { ApprovalRequestHandler } from "../src/approval/requests.js";
import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "../src/approval/types.js";
import type { ConversationTarget } from "../src/conversation-core/events.js";
import { handleApprovalServerRequest } from "../src/codex-client/server-request-adapter.js";
import { JsonRpcError, type RpcServerRequest } from "../src/codex-client/json-rpc.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target: ConversationTarget = { surface: "telegram", accountId: "default", conversationId: "100" };

function handleRaw(
  handler: ApprovalRequestHandler,
  request: RpcServerRequest,
): Promise<unknown> {
  return handleApprovalServerRequest(request, handler);
}

class FakeInteraction implements InteractionPort {
  requests: InteractionRequest[] = [];
  resolvedIds: string[] = [];
  cancelledOutcomes: Array<string | undefined> = [];

  constructor(
    private readonly decision: InteractionDecision = {
      type: "approval",
      approved: true,
      scope: "once",
    },
  ) {}

  async request(
    _target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    this.requests.push(request);
    return this.decision;
  }

  resolved(requestId: string): void {
    this.resolvedIds.push(requestId);
  }

  cancelAll(outcome?: string): void {
    this.cancelledOutcomes.push(outcome);
  }
}

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

describe("resolveApprovalChoice", () => {
  it.each<{
    choice: ApprovalChoice;
    expected: InteractionDecision | undefined;
  }>([
    {
      choice: { type: "once" },
      expected: { type: "approval", approved: true, scope: "once" },
    },
    {
      choice: { type: "session" },
      expected: { type: "approval", approved: true, scope: "session" },
    },
    {
      choice: { type: "execpolicy" },
      expected: { type: "approval", approved: true, scope: "execpolicy" },
    },
    {
      choice: { type: "networkpolicy", amendmentIndex: 1 },
      expected: {
        type: "approval",
        approved: true,
        scope: "networkpolicy",
        networkPolicyAmendment: {
          host: "api.example.com",
          action: "deny",
        },
      },
    },
    {
      choice: { type: "reject" },
      expected: { type: "approval", approved: false },
    },
    {
      choice: { type: "networkpolicy", amendmentIndex: 2 },
      expected: undefined,
    },
  ])("resolves the platform-neutral $choice.type choice", ({ choice, expected }) => {
    const result = resolveApprovalChoice(approvalInteractionRequest(), choice);
    expect(result?.decision).toEqual(expected);
  });

  it("rejects choices that the current request did not offer", () => {
    const request = approvalInteractionRequest({ allowSession: false });
    delete request.execPolicyAmendment;
    delete request.networkPolicyAmendments;

    expect(resolveApprovalChoice(request, { type: "session" })).toBeUndefined();
    expect(resolveApprovalChoice(request, { type: "execpolicy" })).toBeUndefined();
    expect(resolveApprovalChoice(request, {
      type: "networkpolicy",
      amendmentIndex: 0,
    })).toBeUndefined();
  });
});

describe("InteractionRouter", () => {
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

describe("ApprovalCoordinator", () => {
  it("rejects unsupported Server Requests without forwarding raw params", async () => {
    const coordinator = new ApprovalCoordinator(
      routerWithTarget(),
      new FakeInteraction(),
      30_000,
    );

    await expect(handleRaw(coordinator, {
      id: "unsupported-request",
      method: "item/tool/call",
      params: { secret: "must-not-be-forwarded" },
    })).rejects.toMatchObject({
      code: -32601,
      message: "不支持的 App Server 请求：item/tool/call",
    } satisfies Partial<JsonRpcError>);
  });

  it("declines privileged requests that cannot be mapped to a conversation", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const coordinator = new ApprovalCoordinator(
      routerWithoutTarget(),
      new FakeInteraction(),
      30_000,
      logger,
    );

    const response = await handleRaw(coordinator, {
      id: "request-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "unknown",
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch unsafe",
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(logger.info).toHaveBeenCalledWith(
      {
        requestId: "request-1",
        requestType: "command",
        threadId: "unknown",
        turnId: "turn-1",
      },
      "Codex 交互请求已收到",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      {
        requestId: "request-1",
        requestType: "command",
        threadId: "unknown",
        turnId: "turn-1",
        reason: "unmapped-thread",
      },
      "Codex 交互请求没有可投递的外部会话，已安全拒绝",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("touch unsafe");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("touch unsafe");
  });

  it("grants only one command approval through the mapped Telegram conversation", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-2",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "npm test",
      },
    });

    expect(response).toEqual({ decision: "accept" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      requestId: "request-2",
      kind: "command",
      allowSession: true,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
    });
  });

  it("declines a command approval with neither a command nor network context", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-command-missing-preview",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-missing-preview-1",
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("maps an explicit session command approval to the protocol session decision", async () => {
    const interaction = new FakeInteraction({
      type: "approval",
      approved: true,
      scope: "session",
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-command-session",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-session-1",
        command: "npm test",
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    });

    expect(response).toEqual({ decision: "acceptForSession" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      kind: "command",
      allowSession: true,
    });
  });

  it("maps an explicit persistent command prefix approval to the proposed protocol amendment", async () => {
    const amendment = [
      "env",
      "-u",
      "CODEX_CONNECT_HOME",
      "-u",
      "CODEX_CONNECT_CONFIG_FILE",
      "git",
      "commit",
    ];
    const interaction = new FakeInteraction({
      type: "approval",
      approved: true,
      scope: "execpolicy",
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-command-prefix",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-prefix-1",
        command: "env -u CODEX_CONNECT_HOME -u CODEX_CONNECT_CONFIG_FILE git commit -m test",
        proposedExecpolicyAmendment: amendment,
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: amendment,
            },
          },
          "decline",
        ],
      },
    });

    expect(response).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: amendment,
        },
      },
    });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      kind: "command",
      allowSession: false,
      execPolicyAmendment: amendment,
    });
  });

  it("fails closed when a persistent command prefix decision was not offered", async () => {
    const interaction = new FakeInteraction({
      type: "approval",
      approved: true,
      scope: "execpolicy",
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-command-prefix-mismatch",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-prefix-mismatch-1",
        command: "git commit -m test",
        proposedExecpolicyAmendment: ["git", "commit"],
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git"],
            },
          },
          "decline",
        ],
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests[0]).not.toHaveProperty("execPolicyAmendment");
  });

  it("maps an explicit persistent network approval to the proposed protocol amendment", async () => {
    const amendment = { host: "api.example.com", action: "allow" as const };
    const interaction = new FakeInteraction({
      type: "approval",
      approved: true,
      scope: "networkpolicy",
      networkPolicyAmendment: amendment,
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-network-policy",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "network-policy-1",
        command: "curl https://api.example.com",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
        proposedNetworkPolicyAmendments: [amendment],
        availableDecisions: [
          "accept",
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: amendment,
            },
          },
          "decline",
        ],
      },
    });

    expect(response).toEqual({
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      },
    });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      kind: "command",
      networkPolicyAmendments: [amendment],
    });
    expect(
      (interaction.requests[0] as Extract<InteractionRequest, { type: "approval" }>).detail,
    ).toContain("持久网络规则：允许 api.example.com");
  });

  it("renders a network-only approval without inventing a command preview", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    const amendments = [
      { host: "api.example.com", action: "allow" as const },
      { host: "api.example.com", action: "deny" as const },
    ];

    const response = await handleRaw(coordinator, {
      id: "request-network-only",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "network-only-1",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
        proposedNetworkPolicyAmendments: amendments,
        availableDecisions: [
          "accept",
          "acceptForSession",
          ...amendments.map((networkPolicyAmendment) => ({
            applyNetworkPolicyAmendment: {
              network_policy_amendment: networkPolicyAmendment,
            },
          })),
          "decline",
        ],
      },
    });

    expect(response).toEqual({ decision: "accept" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      title: "Codex 请求访问网络",
      networkApprovalContext: {
        host: "api.example.com",
        protocol: "https",
      },
      networkPolicyAmendments: amendments,
    });
    const detail = (
      interaction.requests[0] as Extract<InteractionRequest, { type: "approval" }>
    ).detail;
    expect(detail).toContain("网络目标：api.example.com");
    expect(detail).toContain("协议：https");
    expect(detail).not.toContain("未提供命令预览");
  });

  it("fails closed when a persistent network amendment targets another host", async () => {
    const interaction = new FakeInteraction({
      type: "approval",
      approved: true,
      scope: "networkpolicy",
      networkPolicyAmendment: { host: "other.example.com", action: "allow" },
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-network-policy-mismatch",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "network-policy-mismatch-1",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
        proposedNetworkPolicyAmendments: [{
          host: "other.example.com",
          action: "allow",
        }],
        availableDecisions: [
          "accept",
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "other.example.com",
                action: "allow",
              },
            },
          },
          "decline",
        ],
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("fails closed when persistent network proposals and decisions differ", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-network-decision-mismatch",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "network-decision-mismatch-1",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
        proposedNetworkPolicyAmendments: [{
          host: "api.example.com",
          action: "allow",
        }],
        availableDecisions: [
          "accept",
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "api.example.com",
                action: "deny",
              },
            },
          },
          "decline",
        ],
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("fails closed when a persistent network decision has no matching proposal", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-network-missing-proposal",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "network-missing-proposal-1",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
        availableDecisions: [
          "accept",
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "api.example.com",
                action: "allow",
              },
            },
          },
          "decline",
        ],
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("uses the official allow-only fallback when network decisions are absent", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-network-legacy-fallback",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "network-legacy-fallback-1",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
        proposedNetworkPolicyAmendments: [
          { host: "api.example.com", action: "allow" },
          { host: "api.example.com", action: "deny" },
        ],
      },
    });

    expect(response).toEqual({ decision: "accept" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      networkPolicyAmendments: [{
        host: "api.example.com",
        action: "allow",
      }],
    });
  });

  it("hides session approval when the command request does not offer it", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-command-once-only",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-once-1",
        command: "npm test",
        availableDecisions: ["accept", "decline"],
      },
    });

    expect(response).toEqual({ decision: "accept" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      kind: "command",
      allowSession: false,
    });
  });

  it("shows experimental additional permissions before approving a command", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-additional-permissions",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-permissions-1",
        command: "npm test",
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/workspace/input"],
            write: ["/workspace/output"],
            entries: [
              {
                access: "read",
                path: { type: "glob_pattern", pattern: "/workspace/**/*.json" },
              },
            ],
          },
        },
      },
    });

    expect(response).toEqual({ decision: "accept" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      kind: "command",
      detail: expect.stringContaining("额外权限"),
    });
    const detail = (interaction.requests[0] as Extract<InteractionRequest, { type: "approval" }>)
      .detail;
    expect(detail).toContain("网络：开启");
    expect(detail).toContain("读取：/workspace/input");
    expect(detail).toContain("写入：/workspace/output");
    expect(detail).toContain("读取规则：/workspace/**/*.json");
  });

  it("declines malformed experimental command permissions without prompting", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-malformed-additional-permissions",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-permissions-malformed",
        command: "npm test",
        additionalPermissions: {
          network: { enabled: "yes" },
        },
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("declines command approval when one-time acceptance is not offered", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-without-one-time-accept",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-decisions-1",
        command: "npm test",
        availableDecisions: ["decline", "cancel"],
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("declines a mapped approval that is missing its turn or item identity", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-malformed",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "npm test" },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
  });

  it("maps an approved file change without extending the approval scope", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-file",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-1",
        reason: "更新测试",
      },
    });

    expect(response).toEqual({ decision: "accept" });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      requestId: "request-file",
      kind: "file",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "file-1",
      detail: "更新测试",
      allowSession: true,
    });
  });

  it("returns only the approved turn-scoped permissions", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["/workspace"], write: ["/workspace"] },
    };

    const response = await handleRaw(coordinator, {
      id: "request-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permissions-1",
        permissions,
      },
    });

    expect(response).toEqual({
      permissions: {
        network: permissions.network,
        fileSystem: permissions.fileSystem,
      },
      scope: "turn",
    });
    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      requestId: "request-permissions",
      kind: "permissions",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "permissions-1",
      allowSession: false,
    });
  });

  it("preserves user-input ownership and maps answers back to App Server", async () => {
    const interaction = new FakeInteraction({
      type: "user-input",
      answers: { choice: ["safe"] },
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        autoResolutionMs: 60_000,
        questions: [{
          id: "choice",
          header: "选择",
          question: "采用哪种方案？",
          options: [{ label: "safe", description: "安全方案" }],
          isOther: false,
          isSecret: false,
        }],
      },
    });

    expect(interaction.requests[0]).toMatchObject({
      type: "user-input",
      requestId: "request-input",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      expiresInMs: 60_000,
      questions: [{
        id: "choice",
        header: "选择",
        question: "采用哪种方案？",
        options: ["safe"],
        allowOther: false,
        secret: false,
      }],
    });
    expect(response).toEqual({
      answers: { choice: { answers: ["safe"] } },
    });
  });

  it("declines user input that is missing its turn or item identity", async () => {
    const interaction = new FakeInteraction({
      type: "user-input",
      answers: { choice: ["unsafe"] },
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-input-malformed",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        questions: [],
      },
    });

    expect(response).toEqual({ answers: {} });
    expect(interaction.requests).toEqual([]);
  });

  it("preserves MCP elicitation ownership and maps accepted content", async () => {
    const interaction = new FakeInteraction({
      type: "elicitation",
      action: "accept",
      content: { account: "work" },
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-mcp",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "calendar",
        mode: "url",
        message: "连接日历",
        url: "https://example.test/connect",
      },
    });

    expect(interaction.requests[0]).toMatchObject({
      type: "elicitation",
      requestId: "request-mcp",
      threadId: "thread-1",
      turnId: "turn-1",
      title: "MCP calendar 请求输入",
      mode: "url",
      url: "https://example.test/connect",
    });
    expect(response).toEqual({
      action: "accept",
      content: { account: "work" },
      _meta: null,
    });
  });

  it("maps an MCP tool approval to a session decision without asking for JSON", async () => {
    const interaction = new FakeInteraction({
      type: "elicitation",
      action: "accept",
      content: null,
      scope: "session",
    });
    const coordinator = new ApprovalCoordinator(
      routerWithTarget(),
      interaction,
      30_000,
    );

    const response = await handleRaw(coordinator, {
      id: "request-mcp-tool",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps",
        mode: "form",
        message: "Allow GitHub to update a pull request?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_name: "GitHub",
          tool_title: "Update pull request",
          persist: ["session", "always"],
          tool_params_display: [{
            name: "pull_number",
            display_name: "Pull request",
            value: 146,
          }],
        },
      },
    });

    expect(interaction.requests[0]).toEqual({
      type: "elicitation",
      requestId: "request-mcp-tool",
      threadId: "thread-1",
      turnId: "turn-1",
      title: "MCP GitHub 请求批准",
      message: "Allow GitHub to update a pull request?",
      mode: "tool-approval",
      toolApproval: {
        toolTitle: "Update pull request",
        detail: "Pull request：146",
        allowSession: true,
        allowAlways: true,
      },
      expiresInMs: 30_000,
    });
    expect(response).toEqual({
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    });
  });

  it("cancels malformed MCP tool approval metadata instead of degrading to a form", async () => {
    const interaction = new FakeInteraction({
      type: "elicitation",
      action: "accept",
      content: { approved: true },
    });
    const coordinator = new ApprovalCoordinator(
      routerWithTarget(),
      interaction,
      30_000,
    );

    const response = await handleRaw(coordinator, {
      id: "request-mcp-tool-malformed",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps",
        mode: "form",
        message: "Allow this tool?",
        requestedSchema: {
          type: "object",
          properties: {},
        },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: "forever",
        },
      },
    });

    expect(response).toEqual({
      action: "cancel",
      content: null,
      _meta: null,
    });
    expect(interaction.requests).toEqual([]);
  });

  it.each([
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["item/tool/requestUserInput", { answers: {} }],
    ["mcpServer/elicitation/request", { action: "cancel", content: null, _meta: null }],
  ])("fails closed for unmapped %s requests", async (method, expected) => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithoutTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: `unmapped:${method}`,
      method,
      params: {
        threadId: "unknown",
        turnId: "turn-1",
        itemId: "item-1",
      },
    });

    expect(response).toEqual(expected);
    expect(interaction.requests).toEqual([]);
  });

  it.each([
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["item/tool/requestUserInput", { answers: {} }],
    ["mcpServer/elicitation/request", { action: "cancel", content: null, _meta: null }],
  ])("maps rejected %s decisions to a safe response", async (method, expected) => {
    const interaction = new FakeInteraction({ type: "approval", approved: false });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: `rejected:${method}`,
      method,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        permissions: { network: { enabled: true } },
        questions: [],
        mode: "form",
      },
    });

    expect(response).toEqual(expected);
  });

  it("invalidates an interaction resolved by another client event", () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    coordinator.resolved("request-3");

    expect(interaction.resolvedIds).toEqual(["request-3"]);
  });
});

function routerWithTarget(): SessionRouter {
  return { targetForThread: () => target } as unknown as SessionRouter;
}

function routerWithoutTarget(): SessionRouter {
  return { targetForThread: () => undefined } as unknown as SessionRouter;
}
