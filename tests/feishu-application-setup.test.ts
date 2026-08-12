import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  feishuCardElements,
  FeishuApplicationSetupController,
  type FeishuApplicationApi,
  type FeishuApplicationSnapshot,
  type FeishuCardDocument,
} from "../src/surfaces/feishu/index.js";

const target = {
  surface: "feishu" as const,
  accountId: "cli_0123456789abcdef",
  conversationId: "oc_chat",
};

describe("Feishu application setup controller", () => {
  it("requires the exact actor and stops after official authorization", async () => {
    const fixture = createFixture(incompleteSnapshot());
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );
    const card = fixture.cards[0]!;
    const value = setupAction(card.card);

    expect(fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_other",
      tag: "button",
      value,
    })).toBe("invalid");
    expect(fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value,
    })).toBe("accepted");
    await settle();

    expect(fixture.api.authorizeApplication).toHaveBeenCalledOnce();
    const doctorOutcome = fixture.updates.filter(
      (update) => update.messageId === card.messageId,
    ).at(-1)?.card;
    expect(doctorOutcome?.header.title.content)
      .toBe("飞书配置完成");
    const outcome = JSON.stringify(doctorOutcome);
    expect(outcome).toContain("菜单、事件与回调已自动配置并提交发布");
    expect(fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value,
    })).toBe("invalid");
    await fixture.controller.close();
  });

  it("opens official authorization in Feishu before automatic configuration", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      grantedTenantScopes: [
        "application:application:self_manage",
      ],
    });
    fixture.api.authorizeApplication.mockImplementation(
      async (_signal, ready) => {
        ready(
          "https://open.feishu.cn/oauth/v1/app/registration?code=one",
          600,
        );
      },
    );
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );
    const card = fixture.cards[0]!;

    fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: setupAction(card.card),
    });
    await settle();

    expect(fixture.api.authorizeApplication).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.any(Function),
      [
        "application:application:patch",
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "im:resource",
        "im:message:readonly",
        "cardkit:card:write",
      ],
    );
    expect(fixture.cards[1]?.card.header.title.content)
      .toBe("授权飞书应用");
    const authorizationCard = JSON.stringify(fixture.cards[1]?.card);
    expect(authorizationCard).toContain(
      "https://applink.feishu.cn/client/web_url/open",
    );
    expect(authorizationCard).toContain("\"multi_url\"");
    expect(authorizationCard).not.toContain(
      "\"url\":\"https://open.feishu.cn/oauth/",
    );
    const outcome = JSON.stringify(
      fixture.updates.filter(
        (update) => update.messageId === card.messageId,
      ).at(-1)?.card,
    );
    expect(outcome).toContain("菜单、事件与回调已自动配置并提交发布");
    await fixture.controller.close();
  });

  it("requests only the missing message resource scope for an existing application", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      grantedTenantScopes: [
        "application:application:self_manage",
        "application:application:patch",
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "im:message:readonly",
        "cardkit:card:write",
      ],
    });
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );
    const card = fixture.cards[0]!;

    fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: setupAction(card.card),
    });
    await settle();

    expect(fixture.api.authorizeApplication).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.any(Function),
      ["im:resource"],
    );
    await fixture.controller.close();
  });

  it("offers authorization when another version is pending", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      hasPendingVersion: true,
    });
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );

    expect(JSON.stringify(fixture.cards[0]?.card))
      .toContain("codexc_feishu_setup_token");
    await fixture.controller.close();
  });

  it("shows a published menu node as defined but disabled", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      botMenus: [{
        menu_id: "7351234567890123456",
        event_key: "codexc_home",
        menu_content_type: 2,
      }],
      botMenuEnabled: false,
      menuConfigured: false,
    });

    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );

    const rendered = JSON.stringify(fixture.cards[0]?.card);
    expect(rendered).toContain("已添加，尚未启用");
    expect(rendered).not.toContain("Codex 菜单：已发布");
    await fixture.controller.close();
  });

  it("prefers observed runtime evidence and offers automatic configuration", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      grantedTenantScopes: [
        "application:application:self_manage",
        "application:application:patch",
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "im:resource",
        "im:message:readonly",
        "cardkit:card:write",
      ],
      cardCallbackConfigured: true,
      botMenuEnabled: true,
      menuConfigured: true,
    });

    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      {
        connectionReady: true,
        cardActionObserved: true,
        menuEventObserved: false,
      },
    );

    const rendered = JSON.stringify(fixture.cards[0]?.card);
    expect(rendered).toContain("- 长连接：已就绪");
    expect(rendered).toContain("- 消息接收：已验证");
    expect(rendered).toContain("- 卡片交互：已验证");
    expect(rendered).toContain("自定义菜单：已启用，事件待确认");
    expect(rendered).not.toContain("消息事件：待配置");
    expect(rendered).not.toContain("当前 Surface 对话必需能力");
    expect(rendered).not.toContain("当前用户 OAuth");
    expect(rendered).toContain("codexc_feishu_setup_token");
    expect(rendered).toContain("可点击下方按钮自动补齐应用配置");
    expect(rendered).not.toContain("https://open.feishu.cn/app/");
    await fixture.controller.close();
  });

  it("does not suggest platform configuration already proven at runtime", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      grantedTenantScopes: [
        "application:application:self_manage",
        "application:application:patch",
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "im:resource",
        "im:message:readonly",
        "cardkit:card:write",
      ],
      messageEventConfigured: false,
      menuEventConfigured: false,
      cardCallbackConfigured: false,
      botMenuEnabled: false,
      menuConfigured: false,
      botMenuDisplayStrategy: 3,
    });

    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      {
        connectionReady: true,
        cardActionObserved: true,
        menuEventObserved: true,
      },
    );

    const card = fixture.cards[0]?.card;
    expect(card?.header.template).toBe("green");
    expect(JSON.stringify(card)).toContain("- 卡片交互：已验证");
    expect(JSON.stringify(card)).toContain("- 自定义菜单：已验证");
    expect(JSON.stringify(card)).not.toContain("打开当前飞书应用");
    expect(JSON.stringify(card)).not.toContain("codexc_feishu_setup_token");
    await fixture.controller.close();
  });

  it("can authorize and retry inspection when the initial inspection is unavailable", async () => {
    const fixture = createFixture(incompleteSnapshot());
    fixture.api.inspect
      .mockRejectedValueOnce(new Error("not authorized"))
      .mockResolvedValueOnce(incompleteSnapshot());
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );
    const card = fixture.cards[0]!;

    expect(JSON.stringify(card.card)).toContain(
      "codexc_feishu_setup_token",
    );
    fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: setupAction(card.card),
    });
    await settle();

    expect(fixture.api.inspect).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(fixture.updates.at(-2)?.card))
      .toContain("菜单、事件与回调已自动配置并提交发布");
    await fixture.controller.close();
  });

  it("reports success when the post-authorization inspection is complete", async () => {
    const fixture = createFixture(incompleteSnapshot());
    fixture.api.inspect
      .mockResolvedValueOnce(incompleteSnapshot())
      .mockResolvedValueOnce({
        ...incompleteSnapshot(),
        grantedTenantScopes: [
          "application:application:self_manage",
          "application:application:patch",
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:resource",
          "im:message:readonly",
          "cardkit:card:write",
        ],
        messageEventConfigured: true,
        menuEventConfigured: true,
        cardCallbackConfigured: true,
        menuConfigured: true,
        botMenuDisplayStrategy: 3,
      });
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );
    const card = fixture.cards[0]!;

    fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: setupAction(card.card),
    });
    await settle();

    expect(fixture.updates.at(-2)?.card.header.title.content)
      .toBe("飞书配置完成");
    expect(JSON.stringify(fixture.updates.at(-2)?.card))
      .toContain("当前应用配置检测也已通过");
    await fixture.controller.close();
  });

  it("keeps runtime evidence authoritative after authorization", async () => {
    const fixture = createFixture(incompleteSnapshot());
    fixture.api.inspect
      .mockResolvedValueOnce(incompleteSnapshot())
      .mockResolvedValueOnce({
        ...incompleteSnapshot(),
        grantedTenantScopes: [
          "application:application:self_manage",
          "application:application:patch",
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:resource",
          "im:message:readonly",
          "cardkit:card:write",
        ],
        botMenuDisplayStrategy: 3,
      });
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      {
        connectionReady: true,
        cardActionObserved: true,
        menuEventObserved: true,
      },
    );
    const card = fixture.cards[0]!;

    fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: setupAction(card.card),
    });
    await settle();

    expect(JSON.stringify(fixture.updates.at(-2)?.card))
      .toContain("当前应用配置检测也已通过");
    expect(JSON.stringify(fixture.updates.at(-2)?.card))
      .not.toContain("打开当前飞书应用");
    await fixture.controller.close();
  });

  it("aborts authorization promptly when its in-chat card cannot be delivered", async () => {
    const cards: Array<{
      chatId: string;
      messageId: string;
      card: FeishuCardDocument;
    }> = [];
    const updates: FeishuCardDocument[] = [];
    const deliveryFailure = Promise.reject<string>(new Error("network"));
    void deliveryFailure.catch(() => {});
    let authorizationSignal: AbortSignal | undefined;
    const api: FeishuApplicationApi = {
      inspect: async () => incompleteSnapshot(),
      configureApplication: async () => ({ changed: true }),
      authorizeApplication: async (signal, ready) => {
        authorizationSignal = signal;
        ready(
          "https://applink.feishu.cn/client/mini_program/open?code=one",
          600,
        );
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    const controller = new FeishuApplicationSetupController(
      target.accountId,
      api,
      {
        deliverCard: async (chatId, card) => {
          if (cards.length > 0) {
            return deliveryFailure;
          }
          const messageId = "om_doctor";
          cards.push({ chatId, messageId, card });
          return messageId;
        },
        deliverText: async () => {},
        updateCard: async (_chatId, _messageId, card) => {
          updates.push(card);
        },
      },
      { isAllowed: () => true },
      pino({ enabled: false }),
    );
    await controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
    );
    const card = cards[0]!;

    controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value: setupAction(card.card),
    });
    try {
      await vi.waitFor(() => {
        expect(authorizationSignal?.aborted).toBe(true);
      });
      expect(updates.at(-1)?.header.title.content)
        .toBe("飞书配置未完成");
    } finally {
      await controller.close();
    }
  });
});

function createFixture(snapshot: FeishuApplicationSnapshot) {
  const cards: Array<{
    chatId: string;
    messageId: string;
    card: FeishuCardDocument;
  }> = [];
  const updates: Array<{
    chatId: string;
    messageId: string;
    card: FeishuCardDocument;
  }> = [];
  const api = {
    inspect: vi.fn(async () => snapshot),
    authorizeApplication: vi.fn<
      FeishuApplicationApi["authorizeApplication"]
    >(async (_signal, ready) => {
      ready(
        "https://applink.feishu.cn/client/mini_program/open?code=one",
        600,
      );
    }),
    configureApplication: vi.fn(async () => ({
      changed: true,
      versionId: "oav_new",
    })),
  };
  const controller = new FeishuApplicationSetupController(
    target.accountId,
    api,
    {
      deliverCard: async (chatId, card) => {
        const messageId = `om_${cards.length + 1}`;
        cards.push({ chatId, messageId, card });
        return messageId;
      },
      deliverText: async () => {},
      updateCard: async (chatId, messageId, card) => {
        updates.push({ chatId, messageId, card });
      },
    },
    {
      isAllowed: ({ actorId }) => actorId === "ou_actor",
    },
    pino({ enabled: false }),
  );
  return { controller, api, cards, updates };
}

function incompleteSnapshot(): FeishuApplicationSnapshot {
  return {
    grantedTenantScopes: [],
    hasPendingVersion: false,
    messageEventConfigured: false,
    menuEventConfigured: false,
    cardCallbackConfigured: false,
    botMenuEnabled: false,
    menuConfigured: false,
    botMenus: [],
  };
}

function runtimeStatus() {
  return {
    connectionReady: true,
    cardActionObserved: true,
    menuEventObserved: false,
  };
}

function setupAction(
  card: FeishuCardDocument,
): Readonly<Record<string, string>> {
  for (const element of feishuCardElements(card)) {
    if (!Array.isArray(element.actions)) {
      continue;
    }
    for (const action of element.actions) {
      if (
        typeof action === "object"
        && action !== null
        && "value" in action
      ) {
        return (action as {
          value: Readonly<Record<string, string>>;
        }).value;
      }
    }
  }
  throw new Error("飞书 Doctor 卡片缺少配置动作");
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
