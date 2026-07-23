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

  async request(
    _target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    this.requests.push(request);
    return { type: "approval", approved: true };
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
