import { describe, expect, it } from "vitest";

import { ApprovalCoordinator } from "../src/approval/coordinator.js";
import { InteractionRouter } from "../src/approval/interaction-router.js";
import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "../src/approval/types.js";
import type { ConversationTarget } from "../src/conversation-core/events.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target: ConversationTarget = { surface: "telegram", accountId: "default", conversationId: "100" };

class FakeInteraction implements InteractionPort {
  requests: InteractionRequest[] = [];
  resolvedIds: string[] = [];
  cancelledOutcomes: Array<string | undefined> = [];

  constructor(
    private readonly decision: InteractionDecision = { type: "approval", approved: true },
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

describe("InteractionRouter", () => {
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
    const router = new InteractionRouter();
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
  });
});

describe("ApprovalCoordinator", () => {
  it("declines privileged requests that cannot be mapped to a conversation", async () => {
    const coordinator = new ApprovalCoordinator(routerWithoutTarget(), new FakeInteraction(), 30_000);

    const response = await coordinator.handle({
      id: "request-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "unknown", command: "touch unsafe" },
    });

    expect(response).toEqual({ decision: "decline" });
  });

  it("grants only one command approval through the mapped Telegram conversation", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await coordinator.handle({
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
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
    });
  });

  it("declines a mapped approval that is missing its turn or item identity", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await coordinator.handle({
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

    const response = await coordinator.handle({
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
    });
  });

  it("returns only the approved turn-scoped permissions", async () => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["/workspace"], write: ["/workspace"] },
      ignored: "must-not-be-returned",
    };

    const response = await coordinator.handle({
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
    });
  });

  it("preserves user-input ownership and maps answers back to App Server", async () => {
    const interaction = new FakeInteraction({
      type: "user-input",
      answers: { choice: ["safe"] },
    });
    const coordinator = new ApprovalCoordinator(routerWithTarget(), interaction, 30_000);

    const response = await coordinator.handle({
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

    const response = await coordinator.handle({
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

    const response = await coordinator.handle({
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

  it.each([
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["item/tool/requestUserInput", { answers: {} }],
    ["mcpServer/elicitation/request", { action: "cancel", content: null, _meta: null }],
  ])("fails closed for unmapped %s requests", async (method, expected) => {
    const interaction = new FakeInteraction();
    const coordinator = new ApprovalCoordinator(routerWithoutTarget(), interaction, 30_000);

    const response = await coordinator.handle({
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

    const response = await coordinator.handle({
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
