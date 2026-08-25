import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  conversationCommandNames,
  isConversationCommandName,
} from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import {
  FeishuCommandCenter,
  feishuCardElements,
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
    expect(card).toMatchObject({ schema: "2.0" });
    const values = collectCardActions(card).flatMap((action) => {
      if (
        typeof action !== "object"
        || action === null
        || !("value" in action)
      ) {
        return [];
      }
      return [(action as { value: Record<string, string> }).value];
    });

    expect(values.map((value) => value.codexc_command)).toEqual(
      feishuCommandCenterActions,
    );
    expect(feishuCommandCenterActions).toEqual([
      "new",
      "resume",
      "status",
      "fast",
      "usage",
      "metrics",
      "limits",
      "model",
      "effort",
      "workspace",
      "goal",
      "plan",
      "schedule",
      "help",
    ]);
    expect(JSON.stringify(card)).toContain("常用");
    expect(JSON.stringify(card)).toContain("模型与工作区");
    expect(JSON.stringify(card)).toContain("更多");
    expect(JSON.stringify(card)).toContain("帮助与更多命令");
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
    expect(categorized.card).toMatchObject({ schema: "2.0" });
    expect(JSON.stringify(categorized.card)).toContain("会话查询");
    expect(JSON.stringify(categorized.card)).toContain("会话操作");
    expect(JSON.stringify(categorized.card)).toContain("能力与集成");
    expect(JSON.stringify(categorized.card)).toContain("当前内容");
    const visibleSharedCommands = new Set(
      [fixture.cards[0]!, categorized].flatMap(({ card }) =>
        collectCardActions(card).flatMap((action) => {
          if (
            typeof action !== "object"
            || action === null
            || !("value" in action)
          ) {
            return [];
          }
          const command = (action as {
            value: Record<string, string>;
          }).value.codexc_command;
          return command && isConversationCommandName(command)
            ? [command]
            : [];
        })),
    );
    expect([...visibleSharedCommands].sort()).toEqual(
      conversationCommandNames
        .filter((command) => command !== "unarchive")
        .toSorted(),
    );
    expect(collectCardActions(categorized).some((action) =>
      typeof action === "object"
      && action !== null
      && "value" in action
      && (action as { value: Record<string, string> }).value.codexc_command === "plugins"
    )).toBe(false);
    for (const command of [
      "stop",
      "archive",
      "pin",
      "unpin",
      "compact",
      "fork",
    ]) {
      expect(() => cardAction(categorized, command)).not.toThrow();
    }

    expect(fixture.center.handleCardAction(
      cardAction(categorized, "skill"),
    )).toBe("accepted");
    await settle();
    expect(fixture.execute).toHaveBeenCalledWith(
      target,
      "skill",
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

  it("opens a directly supplied schedule confirmation as a bound choice card", async () => {
    const fixture = createFixture();
    const input = "confirm 12345678-1234-1234-1234-123456789abc";

    await fixture.center.openResponse(target, "ou_actor", {
      title: "确认创建计划任务",
      description: "确认后保存任务",
      choices: [
        { label: "确认", action: "schedule", input },
        { label: "取消", action: "schedule", input: "list 1" },
      ],
    });

    expect(JSON.stringify(fixture.cards[0]?.card)).toContain("确认创建计划任务");
    expect(fixture.center.handleCardAction(
      cardAction(fixture.cards[0]!, "schedule"),
    )).toBe("accepted");
    await settle();
    expect(fixture.execute).toHaveBeenCalledWith(
      target,
      "schedule",
      "ou_actor",
      input,
    );
  });

  it("renders schedule details as Markdown and replaces accepted confirmation buttons", async () => {
    const cards: Array<{
      chatId: string;
      messageId: string;
      card: FeishuCardDocument;
    }> = [];
    const updateCard = vi.fn(async (
      _chatId: string,
      _messageId: string,
      _card: FeishuCardDocument,
    ) => {
      void [_chatId, _messageId, _card];
    });
    const execute = vi.fn(async () => {});
    const center = new FeishuCommandCenter(
      {
        deliverCard: async (chatId, card) => {
          const messageId = "om_confirmation";
          cards.push({ chatId, messageId, card });
          return messageId;
        },
        updateCard,
      },
      { isAllowed: () => true },
      execute,
      pino({ level: "silent" }),
    );
    const input = "confirm 12345678-1234-1234-1234-123456789abc";

    await center.openResponse(target, "ou_actor", {
      title: "确认创建计划任务",
      description: "**任务**\n- 名称：每日检查",
      descriptionFormat: "markdown",
      choices: [
        {
          label: "确认",
          action: "schedule",
          input,
          acceptedState: {
            title: "已确认创建计划任务",
            description: "请求已提交，原按钮已失效。",
            template: "green",
          },
        },
        {
          label: "取消",
          action: "schedule",
          input: "list 1",
          acceptedState: {
            title: "已取消创建计划任务",
            description: "未创建计划任务。",
            template: "grey",
          },
        },
      ],
    });

    expect(feishuCardElements(cards[0]!.card)).toContainEqual(
      expect.objectContaining({
        tag: "markdown",
      }),
    );
    expect(center.handleCardAction(
      cardAction(cards[0]!, "schedule"),
    )).toBe("accepted");
    await settle();

    expect(updateCard).toHaveBeenCalledTimes(1);
    const updated = updateCard.mock.calls[0]![2] as FeishuCardDocument;
    expect(JSON.stringify(updated)).toContain("已确认创建计划任务");
    expect(collectCardActions(updated)).toHaveLength(0);
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

  it("consumes a Queue start action token after selection", async () => {
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
    ) => action === "queue" && input === ""
      ? {
          title: "Queue 条目",
          choices: [{
            label: "启动",
            action: "queue" as const,
            input: "start queue-1",
          }],
        }
      : undefined);
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
    expect(center.handleCardAction(cardAction(cards[0]!, "help"))).toBe("accepted");
    await settle();
    expect(center.handleCardAction(cardAction(cards[1]!, "queue"))).toBe("accepted");
    await settle();

    const queueCard = cards[2]!;
    const startAction = collectCardActions(queueCard.card).find((action) =>
      typeof action === "object"
      && action !== null
      && "value" in action
      && (action as { value: Record<string, string> }).value.codexc_command_input === "start queue-1"
    ) as { value: Readonly<Record<string, string>> } | undefined;
    if (!startAction) {
      throw new Error("Queue 启动按钮未渲染");
    }
    const action = {
      messageId: queueCard.messageId,
      chatId: queueCard.chatId,
      actorOpenId: "ou_actor",
      tag: "button" as const,
      value: startAction.value,
    };
    expect(center.handleCardAction(action)).toBe("accepted");
    expect(center.handleCardAction(action)).toBe("invalid");
    await settle();
    expect(execute).toHaveBeenLastCalledWith(
      target,
      "queue",
      "ou_actor",
      "start queue-1",
    );
  });

  it("opens one reusable command form and submits its bounded text", async () => {
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
          kind: "form" as const,
          title: "重命名会话",
          description: "输入新的会话名称。",
          action,
          fieldLabel: "会话名称",
          placeholder: "例如：飞书私聊收口",
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
      cardAction(cards[0]!, "help"),
    )).toBe("accepted");
    await settle();
    expect(center.handleCardAction(
      cardAction(cards[1]!, "rename"),
    )).toBe("accepted");
    await settle();

    const formCard = cards[2]!.card;
    expect(formCard).toHaveProperty("schema", "2.0");
    expect(formCard).not.toHaveProperty("elements");
    const form = feishuCardElements(formCard).find((element) =>
      element.tag === "form"
    );
    expect(form).toBeDefined();
    const submitButton = (
      form as { elements: Array<Record<string, unknown>> }
    ).elements.find((element) => element.tag === "button");
    expect(submitButton).toMatchObject({
      form_action_type: "submit",
    });
    expect(submitButton).not.toHaveProperty("action_type");
    expect(submitButton).toMatchObject({
      name: expect.stringMatching(/^codexc_command_submit_[A-Za-z0-9_-]+$/u),
    });
    expect(JSON.stringify(formCard)).toContain("重命名会话");
    const submit = cardAction(cards[2]!, "rename");
    expect(center.handleCardAction({
      ...submit,
      formValues: {
        input: "飞书私聊收口",
        unexpected: "不能透传",
      },
    })).toBe("invalid");
    expect(center.handleCardAction({
      ...submit,
      formValues: { input: "x".repeat(1_001) },
    })).toBe("invalid");
    expect(center.handleCardAction({
      ...submit,
      value: {
        ...submit.value,
        codexc_command: "queue",
      },
      formValues: { input: "不能切换命令" },
    })).toBe("invalid");
    expect(center.handleCardAction({
      ...submit,
      tag: "form_submit",
      formValues: { input: "飞书私聊收口" },
    })).toBe("accepted");
    expect(center.handleCardAction({
      ...submit,
      formValues: { input: "重复执行" },
    })).toBe("invalid");
    await settle();
    expect(execute).toHaveBeenLastCalledWith(
      target,
      "rename",
      "ou_actor",
      "飞书私聊收口",
    );
  });

  it("accepts a command form submit whose button value was dropped", async () => {
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
          kind: "form" as const,
          title: "设置 Thread Goal",
          action,
          fieldLabel: "目标",
          placeholder: "请输入当前 Thread 的目标",
          inputPrefix: "set ",
          multiline: true,
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
      cardAction(cards[0]!, "goal"),
    )).toBe("accepted");
    await settle();

    const submit = cardAction(cards[1]!, "goal");
    const token = submit.value.codexc_command_token!;
    expect(center.handleCardAction({
      messageId: cards[1]!.messageId,
      chatId: target.conversationId,
      actorOpenId: "ou_actor",
      tag: "form_submit",
      value: { codexc_command_token: token },
      formValues: { input: "完成飞书接入" },
    })).toBe("accepted");
    await settle();
    expect(execute).toHaveBeenLastCalledWith(
      target,
      "goal",
      "ou_actor",
      "set 完成飞书接入",
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

  it("consumes a reusable card after a direct state-changing action", async () => {
    const fixture = createFixture();
    await fixture.center.open(target, "ou_actor");

    expect(fixture.center.handleCardAction(
      cardAction(fixture.cards[0]!, "new"),
    )).toBe("accepted");
    expect(fixture.center.handleCardAction(
      cardAction(fixture.cards[0]!, "new"),
    )).toBe("invalid");
    await settle();

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledWith(
      target,
      "new",
      "ou_actor",
      "",
    );
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
  const selectedAction = collectCardActions(sent.card).find((action) => {
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

function collectCardActions(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectCardActions);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const own = "value" in record ? [record] : [];
  return [
    ...own,
    ...Object.values(record).flatMap(collectCardActions),
  ];
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
