import { describe, expect, it, vi } from "vitest";

import { ApprovalCoordinator } from "../src/approval/coordinator.js";
import { InteractionRouter } from "../src/approval/interaction-router.js";
import type { ApprovalRequestHandler } from "../src/approval/requests.js";
import type { InteractionDecision, InteractionRequest } from "../src/approval/types.js";
import { handleApprovalServerRequest } from "../src/codex-client/server-request-adapter.js";
import { FileChangeApprovalContext } from "../src/codex-client/file-change-approval-context.js";
import { JsonRpcError, type RpcServerRequest } from "../src/codex-client/json-rpc.js";
import type { ApprovalTarget, SessionRouter } from "../src/session-routing/router.js";
import { approvalTarget as target, FakeInteraction } from "./approval-test-fixture.js";

function handleRaw(
  handler: ApprovalRequestHandler,
  request: RpcServerRequest,
): Promise<unknown> {
  return handleApprovalServerRequest(request, handler);
}

describe("ApprovalCoordinator", () => {
  it.each(["resolved", "timeout"])("cancels ancestry loading on %s and never presents a late result", async (operation) => {
    vi.useFakeTimers();
    let release!: (route: ApprovalTarget) => void;
    const resolving = new Promise<ApprovalTarget>(resolve => { release = resolve; });
    const interaction = new FakeInteraction();
    const router = { resolveApprovalTarget: () => resolving } as unknown as SessionRouter;
    const coordinator = new ApprovalCoordinator(router, interaction, 100);
    try {
      const result = handleRaw(coordinator, childCommand("child-request", "child"));
      if (operation === "resolved") coordinator.resolved("child-request");
      if (operation === "timeout") await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toEqual({ decision: "decline" });
      release({ target, ownerThreadId: "parent", relatedThreadIds: ["child", "parent"], isCurrent: () => true });
      await Promise.resolve();
      expect(interaction.requests).toEqual([]);
      expect(interaction.resolvedIds).toEqual(["child-request"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not cancel an unresolved approval when an unrelated binding changes", async () => {
    let release!: (route: ApprovalTarget) => void;
    const resolving = new Promise<ApprovalTarget>(resolve => { release = resolve; });
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator({ resolveApprovalTarget: () => resolving } as unknown as SessionRouter, interaction, 30_000);
    const result = handleRaw(coordinator, childCommand("child-request", "child"));
    coordinator.cancelStale();
    release({ target, ownerThreadId: "parent", relatedThreadIds: ["child", "parent"], isCurrent: () => true });
    await expect(result).resolves.toEqual({ decision: "accept" });
    expect(interaction.requests).toHaveLength(1);
  });

  it.each(["ancestor", "all", "surface", "unregister", "unrelated-thread", "unrelated-surface"])(
    "captures %s cancellation before the approval route is known", async (operation) => {
      let release!: (route: ApprovalTarget) => void;
      const resolving = new Promise<ApprovalTarget>(resolve => { release = resolve; });
      const native = new FakeInteraction();
      const interactions = new InteractionRouter();
      const unregister = interactions.register("telegram", "default", native);
      interactions.register("feishu", "other", new FakeInteraction());
      const coordinator = new ApprovalCoordinator({ resolveApprovalTarget: () => resolving } as unknown as SessionRouter, interactions, 30_000);
      const result = handleRaw(coordinator, childCommand("request", "child"));
      if (operation === "ancestor") interactions.cancelThreads(new Set(["parent"]));
      if (operation === "all") interactions.cancelAll();
      if (operation === "surface") {
        interactions.setAvailable("telegram", "default", false);
        interactions.setAvailable("telegram", "default", true);
      }
      if (operation === "unregister") {
        unregister();
        interactions.register("telegram", "default", native);
      }
      if (operation === "unrelated-thread") interactions.cancelThreads(new Set(["unrelated"]));
      if (operation === "unrelated-surface") interactions.setAvailable("feishu", "other", false);
      release({ target, ownerThreadId: "parent", relatedThreadIds: ["child", "parent"], isCurrent: () => true });
      const allowed = operation.startsWith("unrelated");
      await expect(result).resolves.toEqual({ decision: allowed ? "accept" : "decline" });
      expect(native.requests).toHaveLength(allowed ? 1 : 0);
    },
  );

  it("includes ancestry reads in the approval deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const interaction = new FakeInteraction();
    const router = {
      resolveApprovalTarget: async () => {
        clock.mockReturnValue(75);
        return { target, ownerThreadId: "parent", relatedThreadIds: ["child", "parent"], isCurrent: () => true };
      },
    } as unknown as SessionRouter;
    try {
      const coordinator = new ApprovalCoordinator(router, interaction, 100);
      await expect(handleRaw(coordinator, childCommand("request", "child"))).resolves.toEqual({ decision: "accept" });
      expect(interaction.requests[0]).toMatchObject({ expiresInMs: 25, threadId: "child", turnId: "turn-child", itemId: "item-child", title: "子代理 · child · Codex 请求执行命令" });
    } finally { clock.mockRestore(); }
  });

  it("keeps two sibling requests isolated in the same conversation", async () => {
    const requests: InteractionRequest[] = [];
    const answers = new Map<string, (decision: InteractionDecision) => void>();
    const resolved = vi.fn();
    const interaction = new InteractionRouter();
    interaction.register("telegram", "default", {
      request: async (_target, request) => {
        requests.push(request);
        return new Promise<InteractionDecision>(resolve => { answers.set(request.requestId, resolve); });
      },
      resolved,
    });
    const router = {
      resolveApprovalTarget: async (id: string) => ({ target, ownerThreadId: "parent", relatedThreadIds: [id, "parent"], isCurrent: () => true }),
    } as unknown as SessionRouter;
    const coordinator = new ApprovalCoordinator(router, interaction, 30_000);
    const first = handleRaw(coordinator, childCommand("one", "child-one"));
    const second = handleRaw(coordinator, childCommand("two", "child-two"));
    await vi.waitFor(() => expect(requests.map(value => value.requestId)).toEqual(["one"]));
    expect(interaction.hasPendingForThread("parent")).toBe(true);
    coordinator.resolved("one");
    await expect(first).resolves.toEqual({ decision: "decline" });
    expect(requests.map(value => value.requestId)).toEqual(["one", "two"]);
    answers.get("one")?.({ type: "approval", approved: true, scope: "session" });
    answers.get("two")?.({ type: "approval", approved: true, scope: "once" });
    await expect(second).resolves.toEqual({ decision: "accept" });
    expect(resolved).toHaveBeenCalledExactlyOnceWith("one");
    expect(requests[1]).toMatchObject({ threadId: "child-two", turnId: "turn-child-two", itemId: "item-child-two" });
  });

  it.each([true, false])("rejects changed ownership after Surface preparation, cancellation event=%s", async (notify) => {
    let current = true;
    let answer!: (decision: InteractionDecision) => void;
    const request = vi.fn(async () => new Promise<InteractionDecision>(resolve => { answer = resolve; }));
    const resolved = vi.fn();
    const router = { resolveApprovalTarget: async () => ({ target, ownerThreadId: "parent", relatedThreadIds: ["child", "parent"], isCurrent: () => current }) } as unknown as SessionRouter;
    const coordinator = new ApprovalCoordinator(router, { request, resolved }, 30_000);
    const result = handleRaw(coordinator, childCommand("one", "child"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    current = false;
    if (notify) coordinator.cancelStale();
    answer({ type: "approval", approved: true, scope: "session" });
    await expect(result).resolves.toEqual({ decision: "decline" });
    if (notify) expect(resolved).toHaveBeenCalledExactlyOnceWith("one");
  });

  it("bounds unresolved ancestry work and reclaims it on cancellation", async () => {
    const read = vi.fn(() => new Promise<ApprovalTarget>(() => {}));
    const coordinator = new ApprovalCoordinator({ resolveApprovalTarget: read } as unknown as SessionRouter, new FakeInteraction(), 30_000);
    const requests = Array.from({ length: 100 }, (_, index) => handleRaw(coordinator, childCommand(String(index), "child")));
    await expect(handleRaw(coordinator, childCommand("overflow", "child"))).resolves.toEqual({ decision: "decline" });
    expect(read).toHaveBeenCalledTimes(100);
    for (let index = 0; index < 100; index += 1) coordinator.resolved(String(index));
    await expect(Promise.all(requests)).resolves.toEqual(Array(100).fill({ decision: "decline" }));
    const next = handleRaw(coordinator, childCommand("next", "child"));
    expect(read).toHaveBeenCalledTimes(101);
    coordinator.resolved("next");
    await expect(next).resolves.toEqual({ decision: "decline" });
  });

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

  it("labels approvals from a background Thread", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(
      routerWithTarget({ background: true }),
      interaction,
      30_000,
    );

    await handleRaw(coordinator, {
      id: "request-background",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-background-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "npm test",
      },
    });

    expect(interaction.requests[0]).toMatchObject({
      type: "approval",
      title: "后台任务 · thread-backg · Codex 请求执行命令",
      threadId: "thread-background-1",
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

  it("declines write-stdin approvals without a complete preview contract", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-write-stdin",
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "writeStdin",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        approvalId: "stdin-approval-1",
        command: "secret input",
      },
    });

    expect(response).toEqual({ decision: "cancel" });
    expect(interaction.requests).toEqual([]);
  });

  it.each(["once", "session", "reject"] as const)("routes stdin approval independently: %s", async (choice) => {
    const interaction = new FakeInteraction(choice === "reject"
      ? { type: "approval", approved: false }
      : { type: "approval", approved: true, scope: choice });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    const response = await handleRaw(coordinator, {
      id: "stdin-rpc", method: "item/commandExecution/requestApproval",
      params: {
        kind: "writeStdin", threadId: "thread-1", turnId: "turn-1", itemId: "exec-1",
        approvalId: "input-1", command: "write_stdin --session-id 123 'hello\n*world*'",
        cwd: "/workspace", reason: "retained permissions",
        availableDecisions: ["accept", "cancel"],
      },
    });
    expect(response).toEqual({ decision: choice === "once" ? "accept" : "cancel" });
    expect(interaction.requests[0]).toMatchObject({
      kind: "stdin", allowSession: false, title: "Codex 请求向已有终端发送输入",
      threadId: "thread-1", turnId: "turn-1", itemId: "exec-1",
    });
    expect(interaction.requests[0]).not.toHaveProperty("execPolicyAmendment");
    expect(interaction.requests[0]).toHaveProperty("detail", expect.stringContaining("\\n\\u002aworld\\u002a"));
  });

  it.each([
    { availableDecisions: ["accept", "acceptForSession", "cancel"] },
    { approvalId: null },
    { cwd: null },
    { command: "arbitrary command" },
    { command: "write_stdin --session-id 123 " + "x".repeat(4_000) },
    { proposedExecpolicyAmendment: ["write_stdin"] },
  ])("rejects unsafe stdin preview or authorization: %j", async (override) => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    const response = await handleRaw(coordinator, {
      id: "stdin-rpc", method: "item/commandExecution/requestApproval",
      params: {
        kind: "writeStdin", threadId: "thread-1", turnId: "turn-1", itemId: "exec-1",
        approvalId: "input-1", command: "write_stdin --session-id 123 hello", cwd: "/workspace",
        availableDecisions: ["accept", "cancel"], ...override,
      },
    });
    expect(response).toHaveProperty("decision", expect.stringMatching(/^(decline|cancel)$/u));
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
      detail: "更新测试\n\n未取得待修改文件明细，请先在原生 Codex 客户端核对。",
      allowSession: true,
    });
  });

  it("shows exact file operations before approval and escapes ambiguous path characters", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    await handleApprovalServerRequest({ id: "files", method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" } }, coordinator, () => [
      { path: "/new", kind: "add" }, { path: "/delete", kind: "delete" },
      { path: "/old", kind: "update", movePath: "/moved" },
      { path: "/a\n[hidden]\u202e", kind: "update" },
    ]);
    expect(interaction.requests[0]).toMatchObject({ detail:
      '新增："/new"\n删除："/delete"\n移动："/old" → "/moved"\n修改："/a\\n\\u005bhidden\\u005d\\u202e"',
    });
  });

  it("declines file previews that cannot be shown in full without exposing paths to logs", async () => {
    const interaction = new FakeInteraction();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000, logger);
    const response = await coordinator.handle({ type: "file", requestId: "large", threadId: "thread-1",
      turnId: "turn-1", itemId: "item-1", reason: null,
      changes: [{ kind: "add", path: "/private/" + "x".repeat(3_000) }] });
    expect(response).toEqual({ type: "file", decision: "decline" });
    expect(interaction.requests).toEqual([]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("/private/");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "file-preview-too-large" }), expect.any(String));
  });

  it.each(["count", "bytes", "invalid"])("does not offer a missing-details fallback for rejected file list %s", async (kind) => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    const context = new FileChangeApprovalContext();
    const changes = kind === "count" ? Array(101).fill({ path: "/a", kind: { type: "add" } })
      : kind === "bytes" ? [{ path: "/" + "x".repeat(12_001), kind: { type: "add" } }]
      : [{ path: "/a", kind: { type: "unknown" } }];
    context.observe({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
      item: { type: "fileChange", id: "item-1", status: "inProgress", changes } } });
    expect(await handleApprovalServerRequest({ id: "invalid", method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" } }, coordinator,
    request => context.get(request.threadId, request.turnId, request.itemId)))
      .toEqual({ decision: "decline" });
    expect(interaction.requests).toEqual([]);
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

  it.each([true, false])("preserves user-input ownership and blocking=%s without using the deprecated timeout", async (isBlocking) => {
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
        isBlocking,
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
      expiresInMs: expect.any(Number),
      title: isBlocking ? "Codex 等待回答" : "Codex 请求补充信息（可跳过）",
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

  it.each([undefined, null, "true", 1])("declines invalid user-input blocking flags: %s", async (isBlocking) => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    await expect(handleRaw(coordinator, {
      id: "invalid-blocking",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", questions: [], isBlocking },
    })).resolves.toEqual({ answers: {} });
    expect(interaction.requests).toHaveLength(0);
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

  it("cancels unsupported OpenAI user verification elicitation", async () => {
    const interaction = new FakeInteraction({
      type: "elicitation",
      action: "accept",
      content: { proof: "untrusted" },
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await handleRaw(coordinator, {
      id: "request-user-verification",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps",
        mode: "openai/userVerification",
        _meta: { privateVerificationData: "must-not-escape" },
        title: "Verify identity",
        description: "Use a device-bound credential",
        challenge: "untrusted-challenge",
      },
    });

    expect(response).toEqual({ action: "cancel", content: null, _meta: null });
    expect(interaction.requests).toEqual([]);
  });

  it.each([
    ["accept", "once", null],
    ["accept", "session", "session"],
    ["accept", "always", "always"],
    ["decline", undefined, null],
    ["cancel", undefined, null],
  ] as const)("maps MCP tool approval %s / %s without expanding its scope", async (action, scope, persist) => {
    const interaction = new FakeInteraction({
      type: "elicitation",
      action,
      content: null,
      ...(scope ? { scope } : {}),
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
      relatedThreadIds: ["thread-1"],
      isCurrent: expect.any(Function),
      toolApproval: {
        toolTitle: "Update pull request",
        detail: "Pull request：146",
        allowSession: true,
        allowAlways: true,
      },
      expiresInMs: expect.any(Number),
    });
    expect(response).toEqual({
      action,
      content: null,
      _meta: persist === null ? null : { persist },
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

function routerWithTarget(options: { background?: boolean } = {}): SessionRouter {
  return {
    resolveApprovalTarget: async (threadId: string) => ({ target, ownerThreadId: threadId, relatedThreadIds: [threadId], isCurrent: () => true }),
    isBackgroundThread: () => options.background ?? false,
  } as unknown as SessionRouter;
}

function routerWithoutTarget(): SessionRouter {
  return { resolveApprovalTarget: async () => undefined } as unknown as SessionRouter;
}

function childCommand(id: string, threadId: string): RpcServerRequest {
  return {
    id, method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: `turn-${threadId}`, itemId: `item-${threadId}`, command: "npm test" },
  };
}
