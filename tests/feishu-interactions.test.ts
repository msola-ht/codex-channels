import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

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
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
    const fixture = createConfiguredFixture(["ou_actor"], logger);
    const decision = fixture.interactions.request(target, approvalRequest());
    await settle();

    expect(fixture.sentCards).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        surface: "feishu",
        accountId: "cli_0123456789abcdef",
        conversationId: "oc_chat",
        requestId: "approval-1",
        requestType: "approval",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "om_card",
      },
      "飞书交互请求已送达",
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("npm test");
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

  it("logs a failed approval delivery without logging its content", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
    const interactions = new FeishuInteractionPort(
      {
        deliverCard: async () => {
          throw new Error("upstream response contains npm test");
        },
        updateCard: async () => {},
      },
      {
        actors: () => ["ou_actor"],
        rememberActor: () => {},
      },
      {
        isAllowed: ({ actorId }) => actorId === "ou_actor",
      },
      logger,
    );

    await expect(interactions.request(target, approvalRequest())).rejects.toThrow(
      "upstream response contains npm test",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      {
        surface: "feishu",
        accountId: "cli_0123456789abcdef",
        conversationId: "oc_chat",
        requestId: "approval-1",
        requestType: "approval",
        threadId: "thread-1",
        turnId: "turn-1",
        errorType: "Error",
      },
      "飞书交互请求发送失败",
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("npm test");
  });

  it("completes the protocol decision when the outcome card update fails", async () => {
    let sentCard: FeishuCardDocument | undefined;
    const interactions = new FeishuInteractionPort(
      {
        deliverCard: async (_chatId, card) => {
          sentCard = card;
          return "om_card";
        },
        updateCard: async () => {
          throw new Error("card update failed");
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
    const token = interactionToken(sentCard!, "approve-once");

    expect(interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "approve-once",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "approval",
      approved: true,
      scope: "once",
    });
    await expect(interactions.close()).resolves.toBeUndefined();
  });

  it("stops only the latest pending interaction for the exact chat and actor", async () => {
    const fixture = createConfiguredFixture();
    const first = fixture.interactions.request(target, {
      ...approvalRequest(),
      requestId: "request-first",
    });
    const second = fixture.interactions.request(target, {
      ...approvalRequest(),
      requestId: "request-second",
    });
    await settle();

    expect(fixture.interactions.stopForActor(target, "ou_other")).toBe(false);
    expect(fixture.interactions.stopForActor({
      ...target,
      conversationId: "oc_other",
    }, "ou_actor")).toBe(false);
    expect(fixture.interactions.stopForActor(target, "ou_actor")).toBe(true);
    await expect(second).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(fixture.interactions.stopForActor(target, "ou_actor")).toBe(true);
    await expect(first).resolves.toEqual({
      type: "approval",
      approved: false,
    });
    expect(fixture.interactions.stopForActor(target, "ou_actor")).toBe(false);
    await fixture.interactions.close();
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

  it("fails a duplicate request id closed without sending another card", async () => {
    const fixture = createConfiguredFixture();
    const first = fixture.interactions.request(target, approvalRequest());
    const duplicate = fixture.interactions.request(target, approvalRequest());
    let duplicateSettled = false;
    void duplicate.then(() => {
      duplicateSettled = true;
    });
    await settle();

    try {
      expect(fixture.sentCards).toHaveLength(1);
      expect(duplicateSettled).toBe(true);
      await expect(duplicate).resolves.toEqual({
        type: "approval",
        approved: false,
      });
    } finally {
      await fixture.interactions.close();
      await first;
      await duplicate;
    }
  });

  it("fails excess concurrent interactions closed without sending more cards", async () => {
    const fixture = createConfiguredFixture();
    const decisions = Array.from(
      { length: 101 },
      (_, index) => fixture.interactions.request(target, {
        ...approvalRequest(),
        requestId: `approval-${index}`,
      }),
    );

    try {
      await settle();
      expect(fixture.sentCards).toHaveLength(100);
    } finally {
      await fixture.interactions.close();
      await Promise.all(decisions);
    }
    await expect(decisions[100]).resolves.toEqual({
      type: "approval",
      approved: false,
    });
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

  it("cancels the request even when card delivery never settles", async () => {
    vi.useFakeTimers();
    try {
      const interactions = new FeishuInteractionPort(
        {
          deliverCard: () => new Promise<string>(() => {}),
          updateCard: async () => {},
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
      let settled = false;
      void decision.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      const closing = interactions.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      await Promise.resolve();

      expect(settled).toBe(true);
      await expect(decision).resolves.toEqual({
        type: "approval",
        approved: false,
      });
    } finally {
      vi.useRealTimers();
    }
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
    vi.useRealTimers();
  });

  it("submits bounded user-input form values by original question id", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, userInputRequest());
    await settle();

    expect(fixture.sentCards).toHaveLength(1);
    const card = fixture.sentCards[0]!.card;
    const cardJson = JSON.stringify(card);
    expect(card).toMatchObject({ schema: "2.0" });
    expect(cardJson).toContain("\"tag\":\"form\"");
    expect(cardJson).toContain("\"name\":\"codexc_user_input\"");
    expect(cardJson).toContain("\"tag\":\"select_static\"");
    expect(cardJson).toContain("\"name\":\"q0_choice\"");
    expect(cardJson).toContain("\"name\":\"q1_text\"");
    expect(cardJson).toContain("\"input_type\":\"password\"");
    expect(cardJson).toContain("\"form_action_type\":\"submit\"");
    expect(cardJson).not.toContain("\"fallback\"");
    const token = interactionToken(fixture.sentCards[0]!.card, "submit");
    const action = {
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "submit",
      },
      formValues: {
        q0_choice: "其他",
        q1_text: "secret-value",
      },
    };

    expect(fixture.interactions.handleCardAction(action)).toBe("invalid");
    expect(fixture.interactions.handleCardAction({
      ...action,
      formValues: {
        q0_choice: "选项一",
        q1_text: "secret-value",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "user-input",
      answers: {
        choice: ["选项一"],
        secret: ["secret-value"],
      },
    });
    await fixture.interactions.close();
    expect(JSON.stringify(fixture.updatedCards[0]?.card))
      .toContain("已提交回答");
    expect(JSON.stringify(fixture.updatedCards[0]?.card))
      .not.toContain("secret-value");
  });

  it("prefers bounded custom text over a selected option when other input is allowed", async () => {
    const fixture = createConfiguredFixture();
    const request = userInputRequest();
    request.questions = [{
      ...request.questions[0]!,
      allowOther: true,
    }];
    const decision = fixture.interactions.request(target, request);
    await settle();

    const cardJson = JSON.stringify(fixture.sentCards[0]!.card);
    expect(cardJson).toContain("\"name\":\"q0_other\"");
    const token = interactionToken(fixture.sentCards[0]!.card, "submit");
    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "form_submit",
      value: {
        interaction_token: token,
        decision: "submit",
      },
      formValues: {
        q0_choice: "选项一",
        q0_other: "自定义环境",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "user-input",
      answers: {
        choice: ["自定义环境"],
      },
    });
    await fixture.interactions.close();
  });

  it("parses an MCP form as bounded JSON and keeps invalid submissions pending", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, elicitationRequest());
    await settle();
    const cardJson = JSON.stringify(fixture.sentCards[0]!.card);
    expect(fixture.sentCards[0]!.card).toMatchObject({ schema: "2.0" });
    expect(cardJson).toContain("\"name\":\"codexc_mcp_form\"");
    const token = interactionToken(fixture.sentCards[0]!.card, "submit");
    const action = {
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "submit",
      },
      formValues: {
        content: "not-json",
      },
    };

    expect(fixture.interactions.handleCardAction(action)).toBe("invalid");
    expect(fixture.interactions.handleCardAction({
      ...action,
      formValues: {
        content: "{\"project\":\"codex-channels\"}",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "elicitation",
      action: "accept",
      content: { project: "codex-channels" },
    });
    await fixture.interactions.close();
  });

  it("renders MCP tool approval choices instead of a JSON form", async () => {
    const fixture = createConfiguredFixture();
    const request: Extract<InteractionRequest, { type: "elicitation" }> = {
      ...elicitationRequest(),
      title: "MCP GitHub 请求批准",
      mode: "tool-approval",
      message: "允许 GitHub 更新拉取请求吗？",
      toolApproval: {
        toolTitle: "Update pull request",
        detail: "Pull request：146",
        allowSession: true,
        allowAlways: true,
      },
    };
    const decision = fixture.interactions.request(target, request);
    await settle();

    const cardJson = JSON.stringify(fixture.sentCards[0]!.card);
    expect(cardJson).toContain("Update pull request");
    expect(cardJson).toContain("允许一次");
    expect(cardJson).toContain("本会话允许");
    expect(cardJson).toContain("始终允许");
    expect(cardJson).not.toContain("codexc_mcp_form");

    const token = interactionToken(
      fixture.sentCards[0]!.card,
      "mcp-session",
    );
    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "mcp-session",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "elicitation",
      action: "accept",
      content: null,
      scope: "session",
    });
    await fixture.interactions.close();
  });

  it("cancels pending user input when another client resolves it", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, userInputRequest());
    await settle();

    fixture.interactions.resolved("input-1");

    await expect(decision).resolves.toEqual({
      type: "user-input",
      answers: {},
    });
    await fixture.interactions.close();
    expect(JSON.stringify(fixture.updatedCards[0]?.card))
      .toContain("已在其他客户端处理");
  });

  it("supports URL elicitation completion without copying URL content", async () => {
    const fixture = createConfiguredFixture();
    const decision = fixture.interactions.request(target, {
      ...elicitationRequest(),
      mode: "url",
      url: "https://example.com/authorize",
    });
    await settle();

    expect(JSON.stringify(fixture.sentCards[0]?.card))
      .toContain("https://example.com/authorize");
    const token = interactionToken(fixture.sentCards[0]!.card, "complete");
    expect(fixture.interactions.handleCardAction({
      messageId: "om_card",
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: token,
        decision: "complete",
      },
    })).toBe("accepted");
    await expect(decision).resolves.toEqual({
      type: "elicitation",
      action: "accept",
      content: null,
    });
    await fixture.interactions.close();
  });

  it("fails closed for unsupported question counts and unsafe URL schemes", async () => {
    const fixture = createConfiguredFixture();

    await expect(fixture.interactions.request(target, {
      ...userInputRequest(),
      questions: [],
    })).resolves.toEqual({ type: "user-input", answers: {} });
    await expect(fixture.interactions.request(target, {
      ...userInputRequest(),
      questions: [
        ...userInputRequest().questions,
        ...userInputRequest().questions,
      ],
    })).resolves.toEqual({ type: "user-input", answers: {} });
    await expect(fixture.interactions.request(target, {
      ...elicitationRequest(),
      mode: "url",
      url: "javascript:alert(1)",
    })).resolves.toEqual({
      type: "elicitation",
      action: "cancel",
      content: null,
    });
    expect(fixture.sentCards).toEqual([]);
  });
});

function createConfiguredFixture(
  actors: readonly string[] = ["ou_actor"],
  logger?: Logger,
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
    logger,
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
  const token = findInteractionToken(card, decision);
  if (!token) {
    throw new Error(`卡片缺少 ${decision} 动作`);
  }
  return token;
}

function findInteractionToken(
  value: unknown,
  decision: string,
): string | undefined {
  if (Array.isArray(value)) {
    return value
      .map((entry) => findInteractionToken(entry, decision))
      .find((entry) => entry !== undefined);
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const actionValue = record.value;
  if (typeof actionValue === "object" && actionValue !== null) {
    const action = actionValue as Record<string, unknown>;
    if (
      action.decision === decision
      && typeof action.interaction_token === "string"
    ) {
      return action.interaction_token;
    }
  }
  return Object.values(record)
    .map((entry) => findInteractionToken(entry, decision))
    .find((entry) => entry !== undefined);
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

function userInputRequest(): Extract<
  InteractionRequest,
  { type: "user-input" }
> {
  return {
    type: "user-input",
    requestId: "input-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    title: "需要输入",
    questions: [
      {
        id: "choice",
        header: "选择",
        question: "请选择一个选项",
        options: ["选项一", "选项二"],
        allowOther: false,
        secret: false,
      },
      {
        id: "secret",
        header: "密钥",
        question: "请输入敏感值",
        options: [],
        allowOther: true,
        secret: true,
      },
    ],
    expiresInMs: 300_000,
  };
}

function elicitationRequest(): Extract<
  InteractionRequest,
  { type: "elicitation" }
> {
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
