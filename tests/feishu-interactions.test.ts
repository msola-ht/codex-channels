import { describe, expect, it, vi } from "vitest";

import type {
  InteractionRequest,
} from "../src/approval/index.js";
import {
  FeishuInteractionPort,
  type FeishuCardDocument,
} from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu",
  accountId: "cli_0123456789abcdef",
  conversationId: "oc_chat",
} as const;

describe("Feishu interaction port", () => {
  it("binds an approval to the exact chat, message, actor, and one-use token", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, approvalRequest());
    await settle();

    expect(fixture.sentCards).toHaveLength(1);
    const token = interactionToken(fixture.sentCards[0]!.card, "approve-once");
    const action = {
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "approve-once",
      },
    };

    expect(fixture.interactions.handleCardAction({
      ...action,
      actorOpenId: "ou_other",
    })).toBe("invalid");
    expect(fixture.interactions.handleCardAction({
      ...action,
      messageId: "om_other",
    })).toBe("invalid");
    expect(fixture.interactions.handleCardAction(action)).toBe("accepted");
    expect(fixture.interactions.handleCardAction(action)).toBe("stale");

    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "once",
    });
    await fixture.interactions.close();
    expect(fixture.updatedCards).toEqual([expect.objectContaining({
      chatId: target.conversationId,
      messageId: "om_card",
    })]);
    expect(JSON.stringify(fixture.updatedCards[0]?.card))
      .toContain("处理结果：已批准一次");
  });

  it("only maps options that the current request explicitly offers", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, {
      ...approvalRequest(),
      allowSession: false,
    });
    await settle();
    const token = interactionToken(
      fixture.sentCards[0]!.card,
      "approve-once",
    );

    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "approve-session",
      },
    })).toBe("invalid");
    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "reject",
      },
    })).toBe("accepted");

    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await fixture.interactions.close();
  });

  it("maps an offered persistent command prefix without copying the rule", async () => {
    const fixture = createConfiguredFixture();
    const amendment = ["env", "-u", "CODEX_CONNECT_HOME", "git", "commit"];
    const request = {
      ...approvalRequest(),
      allowSession: false,
      execPolicyAmendment: amendment,
    };
    const decision = fixture.interactions.request(target, request);
    await settle();
    const token = interactionToken(
      fixture.sentCards[0]!.card,
      "approve-execpolicy",
    );

    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "approve-execpolicy",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "execpolicy",
    });
    expect(request.execPolicyAmendment).toBe(amendment);
    await fixture.interactions.close();
  });

  it("returns the exact offered network rule selected by index", async () => {
    const fixture = createConfiguredFixture();
    const amendments = [
      { host: "api.example.com", action: "allow" as const },
      { host: "api.example.com", action: "deny" as const },
    ];
    const decision = fixture.interactions.request(target, {
      ...approvalRequest(),
      allowSession: false,
      networkPolicyAmendments: amendments,
    });
    await settle();
    const token = interactionToken(
      fixture.sentCards[0]!.card,
      "approve-network-1",
    );

    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "approve-network-1",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "networkpolicy",
      networkPolicyAmendment: amendments[1],
    });
    await fixture.interactions.close();
  });

  it("fails closed without exactly one currently authorized actor", async () => {
    const noActor = createConfiguredFixture([]);
    const multipleActors = createConfiguredFixture([
      "ou_actor",
      "ou_other",
    ]);

    await expect(
      noActor.interactions.request(target, approvalRequest()),
    ).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await expect(
      multipleActors.interactions.request(target, approvalRequest()),
    ).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(noActor.sentCards).toEqual([]);
    expect(multipleActors.sentCards).toEqual([]);
  });

  it("invalidates a pending card when another client resolves the request", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, approvalRequest());
    await settle();

    fixture.interactions.resolved("approval-1");

    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await fixture.interactions.close();
    expect(JSON.stringify(fixture.updatedCards[0]?.card))
      .toContain("已在其他客户端处理");
  });

  it("does not create pending state when the port closes during card delivery", async () => {
    let finishDelivery: ((messageId: string) => void) | undefined;
    const delivery = new Promise<string>((resolve) => {
      finishDelivery = resolve;
    });
    const updatedCards: FeishuCardDocument[] = [];
    const interactions = new FeishuInteractionPort(
      {
        deliverCard: () => delivery,
        updateCard: async (_chatId, _messageId, card) => {
          updatedCards.push(card);
        },
      },
      {
        actors: () => ["ou_actor"],
        rememberActor: () => {},
      },
      {
        isAllowed: () => true,
      },
    );
    const decision = interactions.request(target, approvalRequest());
    await settle();

    const closing = interactions.close();
    finishDelivery?.("om_card");
    await closing;

    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: "unknown",
        decision: "approve-once",
      },
    })).toBe("stale");
    expect(JSON.stringify(updatedCards[0])).toContain("Gateway 已停止");
  });

  it("times out to a refusal and disables the card", async () => {
    vi.useFakeTimers();
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, {
      ...approvalRequest(),
      expiresInMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    await fixture.interactions.close();
    expect(JSON.stringify(fixture.updatedCards[0]?.card))
      .toContain("请求已超时");
  });

  it.each([
    [
      userInputRequest(),
      { type: "user-input", answers: {} },
    ],
    [
      elicitationRequest(),
      { type: "elicitation", action: "cancel", content: null },
    ],
  ] as const)("continues to fail closed for unsupported %s", async (
    request,
    expected,
  ) => {
    const fixture = createConfiguredFixture();

    await expect(fixture.interactions.request(target, request)).resolves
      .toEqual(expected);
    expect(fixture.sentCards).toEqual([]);
  });
});

function createConfiguredFixture(
  actors: readonly string[] = ["ou_actor"],
) {
  const sentCards: Array<{
    chatId: string;
    card: FeishuCardDocument;
  }> = [];
  const updatedCards: Array<{
    chatId: string;
    messageId: string;
    card: FeishuCardDocument;
  }> = [];
  const interactions = new FeishuInteractionPort(
    {
      deliverCard: async (chatId, card) => {
        sentCards.push({ chatId, card });
        return "om_card";
      },
      updateCard: async (chatId, messageId, card) => {
        updatedCards.push({ chatId, messageId, card });
      },
    },
    {
      actors: () => [...actors],
      rememberActor: () => {},
    },
    {
      isAllowed: ({ actorId }) => actorId === "ou_actor"
        || actorId === "ou_other",
    },
  );
  return {
    interactions,
    sentCards,
    updatedCards,
  };
}

function interactionToken(
  card: FeishuCardDocument,
  decision: string,
): string {
  const action = card.elements.find((element) => element.tag === "action");
  const buttons = action?.actions as Array<{
    value?: {
      interaction_token?: string;
      decision?: string;
    };
  }> | undefined;
  const token = buttons?.find(
    (button) => button.value?.decision === decision,
  )?.value?.interaction_token;
  if (!token) {
    throw new Error(`卡片缺少 ${decision} 动作`);
  }
  return token;
}

function approvalRequest(): Extract<InteractionRequest, { type: "approval" }> {
  return {
    type: "approval",
    requestId: "approval-1",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "运行命令",
    detail: "npm test",
    allowSession: true,
    expiresInMs: 300_000,
  };
}

function userInputRequest(): InteractionRequest {
  return {
    type: "user-input",
    requestId: "input-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "需要输入",
    questions: [],
    expiresInMs: 300_000,
  };
}

function elicitationRequest(): InteractionRequest {
  return {
    type: "elicitation",
    requestId: "elicitation-1",
    threadId: "thread-1",
    turnId: null,
    title: "MCP 请求",
    message: "需要确认",
    mode: "form",
    expiresInMs: 300_000,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
