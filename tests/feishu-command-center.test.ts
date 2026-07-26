import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import {
  FeishuCommandCenter,
  feishuCommandCenterActions,
  feishuCommandMenuEventKey,
  renderFeishuCommandCenterCard,
  type FeishuCardAction,
  type FeishuCardDocument,
} from "../src/surfaces/feishu/index.js";

const target: ConversationTarget = {
  surface: "feishu",
  accountId: "cli_0123456789abcdef",
  conversationId: "oc_chat",
};

describe("Feishu command center", () => {
  it("uses one bot menu event to open the categorized command center", () => {
    expect(feishuCommandMenuEventKey).toBe("codexc_home");
  });

  it("renders common actions first and groups the remaining actions", () => {
    const card = renderFeishuCommandCenterCard("opaque-token");
    const values = card.elements.flatMap((element) =>
      Array.isArray(element.actions)
        ? element.actions.flatMap((action) => {
            if (
              typeof action !== "object"
              || action === null
              || !("value" in action)
            ) {
              return [];
            }
            return [(action as {
              value: Record<string, string>;
            }).value];
          })
        : [],
    );

    expect(values.map((value) => value.codexc_command)).toEqual(
      feishuCommandCenterActions,
    );
    expect(feishuCommandCenterActions).toEqual([
      "new",
      "resume",
      "status",
      "fast",
      "usage",
      "limits",
      "model",
      "effort",
      "workspace",
      "goal",
      "help",
    ]);
    expect(JSON.stringify(card)).toContain("常用");
    expect(JSON.stringify(card)).toContain("模型与工作区");
    expect(JSON.stringify(card)).toContain("更多");
    expect(values.every(
      (value) => value.codexc_command_token === "opaque-token",
    )).toBe(true);
  });

  it("opens a categorized command card instead of sending the full text help", async () => {
    const fixture = createFixture();
    await fixture.center.open(target, "ou_actor");

    expect(fixture.center.handleCardAction(
      cardAction(fixture.cards[0]!, "help"),
    )).toBe("accepted");
    await settle();

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.cards).toHaveLength(2);
    const categorized = fixture.cards[1]!;
    expect(JSON.stringify(categorized.card)).toContain("会话查询");
    expect(JSON.stringify(categorized.card)).toContain("能力与集成");
    expect(JSON.stringify(categorized.card)).toContain("当前内容");

    expect(fixture.center.handleCardAction(
      cardAction(categorized, "skills"),
    )).toBe("accepted");
    await settle();
    expect(fixture.execute).toHaveBeenCalledWith(
      target,
      "skills",
      "ou_actor",
      "",
    );
    expect(fixture.center.handleCardAction(
      cardAction(categorized, "whoami"),
    )).toBe("accepted");
    await settle();
    expect(fixture.execute).toHaveBeenCalledWith(
      target,
      "whoami",
      "ou_actor",
      "",
    );
  });

  it("opens bounded choices and executes the selected value", async () => {
    const cards: Array<{
      chatId: string;
      messageId: string;
      card: FeishuCardDocument;
    }> = [];
    const execute = vi.fn(async (
      _target,
      action,
      _actorId,
      input,
    ) => input
      ? undefined
      : {
          title: "选择模型",
          description: "当前：gpt-a",
          choices: [{
            label: "GPT B",
            action,
            input: "gpt-b",
          }],
        });
    const center = new FeishuCommandCenter(
      {
        deliverCard: async (chatId, card) => {
          const messageId = `om_card_${cards.length + 1}`;
          cards.push({ chatId, messageId, card });
          return messageId;
        },
      },
      { isAllowed: () => true },
      execute,
      pino({ level: "silent" }),
    );
    await center.open(target, "ou_actor");

    expect(center.handleCardAction(
      cardAction(cards[0]!, "model"),
    )).toBe("accepted");
    await settle();
    expect(cards).toHaveLength(2);
    expect(JSON.stringify(cards[1]?.card)).toContain("选择模型");

    expect(center.handleCardAction(
      cardAction(cards[1]!, "model"),
    )).toBe("accepted");
    await settle();
    expect(execute).toHaveBeenLastCalledWith(
      target,
      "model",
      "ou_actor",
      "gpt-b",
    );
  });

  it("rejects a value that was not rendered on the selection card", async () => {
    const cards: Array<{
      chatId: string;
      messageId: string;
      card: FeishuCardDocument;
    }> = [];
    const execute = vi.fn(async (
      _target,
      action,
      _actorId,
      input,
    ) => input
      ? undefined
      : {
          title: "选择模型",
          choices: [{ label: "GPT B", action, input: "gpt-b" }],
        });
    const center = new FeishuCommandCenter(
      {
        deliverCard: async (chatId, card) => {
          const messageId = `om_card_${cards.length + 1}`;
          cards.push({ chatId, messageId, card });
          return messageId;
        },
      },
      { isAllowed: () => true },
      execute,
      pino({ level: "silent" }),
    );
    await center.open(target, "ou_actor");
    expect(center.handleCardAction(
      cardAction(cards[0]!, "model"),
    )).toBe("accepted");
    await settle();

    const valid = cardAction(cards[1]!, "model");
    expect(center.handleCardAction({
      ...valid,
      value: {
        ...valid.value,
        codexc_command_input: "gpt-unauthorized",
      },
    })).toBe("invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("binds reusable read-only actions to the exact card, chat, actor, and access policy", async () => {
    const fixture = createFixture();
    await fixture.center.open(target, "ou_actor");
    const action = cardAction(fixture.cards[0]!);

    expect(fixture.center.handleCardAction(action)).toBe("accepted");
    expect(fixture.center.handleCardAction({
      ...action,
      value: {
        ...action.value,
        codexc_command: "usage",
      },
    })).toBe("accepted");
    await settle();

    expect(fixture.execute).toHaveBeenNthCalledWith(
      1,
      target,
      "status",
      "ou_actor",
      "",
    );
    expect(fixture.execute).toHaveBeenNthCalledWith(
      2,
      target,
      "usage",
      "ou_actor",
      "",
    );
    expect(fixture.center.handleCardAction({
      ...action,
      actorOpenId: "ou_other",
    })).toBe("invalid");
    expect(fixture.center.handleCardAction({
      ...action,
      chatId: "oc_other",
    })).toBe("invalid");
    expect(fixture.center.handleCardAction({
      ...action,
      messageId: "om_other",
    })).toBe("invalid");
  });

  it("deduplicates menu events and expires command tokens", async () => {
    let now = 1_000;
    const fixture = createFixture({
      now: () => now,
      tokenTtlMs: 100,
      eventDeduplicationTtlMs: 100,
    });

    await fixture.center.openFromMenu(
      target,
      "ou_actor",
      "event-menu-1",
    );
    await fixture.center.openFromMenu(
      target,
      "ou_actor",
      "event-menu-1",
    );
    expect(fixture.cards).toHaveLength(1);

    const action = cardAction(fixture.cards[0]!);
    now += 101;
    expect(fixture.center.handleCardAction(action)).toBe("invalid");

    await fixture.center.openFromMenu(
      target,
      "ou_actor",
      "event-menu-1",
    );
    expect(fixture.cards).toHaveLength(2);
  });

  it("allows a platform retry when the first menu card delivery fails", async () => {
    const deliverCard = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("om_card");
    const center = new FeishuCommandCenter(
      { deliverCard },
      { isAllowed: () => true },
      async () => {},
      pino({ level: "silent" }),
    );

    await expect(center.openFromMenu(
      target,
      "ou_actor",
      "event-menu-1",
    )).rejects.toThrow("network");
    await expect(center.openFromMenu(
      target,
      "ou_actor",
      "event-menu-1",
    )).resolves.toBeUndefined();

    expect(deliverCard).toHaveBeenCalledTimes(2);
  });

  it("ignores other interaction cards and fails closed for command-shaped invalid actions", async () => {
    const fixture = createFixture();

    expect(fixture.center.handleCardAction({
      messageId: "om_approval",
      chatId: "oc_chat",
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: "approval-token",
        decision: "approve-once",
      },
    })).toBe("ignored");
    expect(fixture.center.handleCardAction({
      messageId: "om_card",
      chatId: "oc_chat",
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        codexc_command_token: "unknown",
        codexc_command: "new",
      },
    })).toBe("invalid");
  });

  it("waits for accepted command work before closing", async () => {
    let finish: (() => void) | undefined;
    let sentCard:
      | { chatId: string; messageId: string; card: FeishuCardDocument }
      | undefined;
    const center = new FeishuCommandCenter(
      {
        deliverCard: async (chatId, card) => {
          sentCard = { chatId, messageId: "om_card", card };
          return "om_card";
        },
      },
      { isAllowed: () => true },
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
      pino({ level: "silent" }),
    );
    await center.open(target, "ou_actor");
    if (!sentCard) {
      throw new Error("命令中心卡片未发送");
    }
    expect(center.handleCardAction(cardAction(sentCard))).toBe("accepted");

    let closed = false;
    const closing = Promise.resolve(center.close()).then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    finish?.();
    await closing;
  });
});

function createFixture(
  options: ConstructorParameters<typeof FeishuCommandCenter>[4] = {},
): {
  center: FeishuCommandCenter;
  cards: Array<{ chatId: string; messageId: string; card: FeishuCardDocument }>;
  execute: ReturnType<typeof vi.fn>;
} {
  const cards: Array<{
    chatId: string;
    messageId: string;
    card: FeishuCardDocument;
  }> = [];
  const execute = vi.fn(async () => {});
  const center = new FeishuCommandCenter(
    {
      deliverCard: async (chatId, card) => {
        const messageId = `om_card_${cards.length + 1}`;
        cards.push({ chatId, messageId, card });
        return messageId;
      },
    },
    {
      isAllowed: ({ actorId }) => actorId === "ou_actor",
    },
    execute,
    pino({ level: "silent" }),
    options,
  );
  return { center, cards, execute };
}

function cardAction(
  sent: { chatId: string; messageId: string; card: FeishuCardDocument },
  command = "status",
): FeishuCardAction {
  const selectedAction = sent.card.elements.flatMap((element) =>
    Array.isArray(element.actions) ? element.actions : [],
  ).find((action) => {
    if (
      typeof action !== "object"
      || action === null
      || !("value" in action)
    ) {
      return false;
    }
    return (action as {
      value: Record<string, string>;
    }).value.codexc_command === command;
  }) as {
    value: Readonly<Record<string, string>>;
  } | undefined;
  if (!selectedAction) {
    throw new Error(`飞书命令中心动作不存在：${command}`);
  }
  return {
    messageId: sent.messageId,
    chatId: sent.chatId,
    actorOpenId: "ou_actor",
    tag: "button",
    value: selectedAction.value,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
