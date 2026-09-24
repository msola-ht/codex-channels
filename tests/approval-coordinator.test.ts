import { describe, expect, it, vi } from "vitest";

import { ApprovalCoordinator } from "../src/approval/coordinator.js";
import type { ApprovalRequestHandler } from "../src/approval/requests.js";
import type { InteractionRequest } from "../src/approval/types.js";
import { handleApprovalServerRequest } from "../src/codex-client/server-request-adapter.js";
import { JsonRpcError, type RpcServerRequest } from "../src/codex-client/json-rpc.js";
import type { SessionRouter } from "../src/session-routing/router.js";
import { approvalTarget as target, FakeInteraction } from "./approval-test-fixture.js";

function handleRaw(
  handler: ApprovalRequestHandler,
  request: RpcServerRequest,
): Promise<unknown> {
  return handleApprovalServerRequest(request, handler);
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

  it("declines write-stdin approvals until their distinct review is supported", async () => {
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
      expiresInMs: 30_000,
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
      toolApproval: {
        toolTitle: "Update pull request",
        detail: "Pull request：146",
        allowSession: true,
        allowAlways: true,
      },
      expiresInMs: 30_000,
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
    targetForThread: () => target,
    isBackgroundThread: () => options.background ?? false,
  } as unknown as SessionRouter;
}

function routerWithoutTarget(): SessionRouter {
  return { targetForThread: () => undefined } as unknown as SessionRouter;
}
