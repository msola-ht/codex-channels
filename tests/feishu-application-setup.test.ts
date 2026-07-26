import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
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
  it("requires the exact actor and applies a one-time confirmed setup", async () => {
    const fixture = createFixture(incompleteSnapshot());
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
      "valid",
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

    expect(fixture.api.configureAndPublish).toHaveBeenCalledOnce();
    expect(fixture.updates.at(-1)?.card.header.title.content)
      .toBe("飞书应用配置完成");
    expect(fixture.controller.handleCardAction({
      messageId: card.messageId,
      chatId: card.chatId,
      actorOpenId: "ou_actor",
      tag: "button",
      value,
    })).toBe("invalid");
    await fixture.controller.close();
  });

  it("opens application authorization before configuring when patch scope is missing", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      hasPatchScope: false,
    });
    fixture.api.authorizeConfiguration.mockImplementation(
      async (_signal, ready) => {
        ready(
          "https://accounts.feishu.cn/open-apis/authen/v1/index?code=one",
          600,
        );
      },
    );
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
      "missing",
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

    expect(fixture.api.authorizeConfiguration).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(fixture.cards[1]?.card.header.title.content)
      .toBe("授权飞书应用配置");
    const authorizationCard = JSON.stringify(fixture.cards[1]?.card);
    expect(authorizationCard).toContain(
      "https://applink.feishu.cn/client/web_url/open",
    );
    expect(authorizationCard).toContain("\"multi_url\"");
    expect(authorizationCard).not.toContain(
      "\"url\":\"https://accounts.feishu.cn/open-apis/",
    );
    expect(fixture.api.configureAndPublish).toHaveBeenCalledOnce();
    await fixture.controller.close();
  });

  it("does not offer automatic publication when another version is pending", async () => {
    const fixture = createFixture({
      ...incompleteSnapshot(),
      hasPendingVersion: true,
    });
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
      "valid",
    );

    expect(fixture.cards).toHaveLength(1);
    expect(JSON.stringify(fixture.cards[0]?.card))
      .not.toContain("codexc_feishu_setup_token");
    expect(JSON.stringify(fixture.cards[0]?.card))
      .toContain("已有未完成版本");
    expect(fixture.api.configureAndPublish).not.toHaveBeenCalled();
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
      "missing",
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

    expect(fixture.api.inspect).toHaveBeenCalledTimes(2);
    expect(fixture.api.configureAndPublish).toHaveBeenCalledOnce();
    await fixture.controller.close();
  });

  it("does not publish when the post-authorization inspection is complete", async () => {
    const fixture = createFixture(incompleteSnapshot());
    fixture.api.inspect
      .mockResolvedValueOnce(incompleteSnapshot())
      .mockResolvedValueOnce({
        ...incompleteSnapshot(),
        hasPatchScope: true,
        messageEventConfigured: true,
        menuEventConfigured: true,
        cardCallbackConfigured: true,
        menuConfigured: true,
      });
    await fixture.controller.openDoctor(
      target,
      "ou_actor",
      runtimeStatus(),
      "valid",
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

    expect(fixture.api.configureAndPublish).not.toHaveBeenCalled();
    expect(fixture.updates.at(-2)?.card.header.title.content)
      .toBe("飞书应用配置完成");
    expect(JSON.stringify(fixture.updates.at(-2)?.card))
      .toContain("无需提交新版本");
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
      authorizeConfiguration: async (signal, ready) => {
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
      configureAndPublish: async () => ({
        versionId: "oav_new",
      }),
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
      "valid",
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
        .toBe("飞书应用配置未完成");
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
    authorizeConfiguration: vi.fn<
      FeishuApplicationApi["authorizeConfiguration"]
    >(async (_signal, ready) => {
      ready(
        "https://applink.feishu.cn/client/mini_program/open?code=one",
        600,
      );
    }),
    configureAndPublish: vi.fn<
      FeishuApplicationApi["configureAndPublish"]
    >(async () => ({
      versionId: "oav_new",
      version: "1.2.3",
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
    hasPatchScope: true,
    hasPendingVersion: false,
    messageEventConfigured: false,
    menuEventConfigured: false,
    cardCallbackConfigured: false,
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
  for (const element of card.elements) {
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
