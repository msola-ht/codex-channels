import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ConversationUseCases } from "../src/application/index.js";
import {
  feishuCardElements,
  FeishuEventConnection,
  type FeishuApplicationSnapshot,
  type FeishuCardDocument,
} from "../src/surfaces/feishu/index.js";
import { FeishuSurface } from "../src/surfaces/feishu/surface.js";

describe("Feishu Surface", () => {
  it("records sanitized connection lifecycle transitions", async () => {
    const fixture = createFixture();

    const starting = fixture.surface.start();
    fixture.ready();
    await starting;
    fixture.reconnecting();
    fixture.reconnected();
    await fixture.surface.stop();
    await fixture.surface.stop();

    expect(fixture.logs.map((entry) => entry.msg)).toEqual([
      "飞书长连接正在连接",
      "飞书长连接已就绪",
      "飞书长连接正在重连",
      "飞书长连接已恢复",
      "飞书 Surface 已停止",
    ]);
    expect(fixture.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: "feishu",
        accountId: "cli_0123456789abcdef",
      }),
    ]));
    expect(JSON.stringify(fixture.logs)).not.toContain("secret");
  });

  it("deduplicates a replayed event across a reconnect", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const fixture = createFixture({ submit });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMessage(0);
    await settle();
    fixture.reconnecting();
    fixture.reconnected();
    fixture.emitMessage(0);
    await fixture.surface.stop();

    expect(submit).toHaveBeenCalledOnce();
  });

  it("starts the event connection and closes it on stop", async () => {
    const fixture = createFixture();

    const starting = fixture.surface.start();
    expect(fixture.sdkStart).toHaveBeenCalledOnce();
    fixture.ready();
    await expect(starting).resolves.toBeUndefined();

    await fixture.surface.stop();
    await fixture.surface.stop();

    expect(fixture.sdkClose).toHaveBeenCalledOnce();
    expect(fixture.sdkClose).toHaveBeenCalledWith(false);
  });

  it("sends startup notifications after the connection is ready", async () => {
    const fixture = createFixture(
      undefined,
      undefined,
      {
        messages: () => [{
          chatId: "oc_chat",
          text: "Codex Connect 已联通",
        }],
      },
    );

    const starting = fixture.surface.start();
    expect(fixture.sent).toEqual([]);
    fixture.ready();
    await starting;
    await fixture.surface.stop();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "Codex Connect 已联通",
    }]);
  });

  it("keeps running when startup notification generation fails", async () => {
    const fixture = createFixture(
      undefined,
      undefined,
      {
        messages() {
          throw new Error("Authorization: secret");
        },
      },
    );

    const starting = fixture.surface.start();
    fixture.ready();
    await expect(starting).resolves.toBeUndefined();
    await fixture.surface.stop();

    expect(fixture.sent).toEqual([]);
    expect(fixture.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        msg: "飞书启动联通通知生成失败",
        errorType: "Error",
      }),
    ]));
    expect(JSON.stringify(fixture.logs)).not.toContain("secret");
  });

  it("rejects invalid and duplicate startup notification chats", async () => {
    const fixture = createFixture(
      undefined,
      undefined,
      {
        messages: () => [
          { chatId: "oc_chat", text: "第一条" },
          { chatId: "oc_chat", text: "重复消息" },
          { chatId: "invalid_chat", text: "非法消息" },
        ],
      },
    );

    const starting = fixture.surface.start();
    fixture.ready();
    await starting;
    await fixture.surface.stop();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "第一条",
    }]);
    expect(fixture.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        msg: "飞书启动联通通知收件人无效",
      }),
    ]));
    expect(JSON.stringify(fixture.logs)).not.toContain("invalid_chat");
  });

  it("drains accepted input and its confirmation before stopping", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      submit: async () => {
        await gate;
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          steered: true,
        };
      },
    });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMessage();
    await settle();
    const stopping = fixture.surface.stop();
    release();
    await stopping;

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "已将补充要求追加到当前 Turn。",
    }]);
    expect(fixture.sdkClose).toHaveBeenCalledWith(false);
  });

  it("fails closed until configuration notification recipients are composed", async () => {
    const fixture = createFixture();

    await expect(fixture.surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [],
    })).rejects.toThrow("尚未配置安全的配置通知收件人");

    await fixture.surface.stop();
  });

  it("delivers configuration notifications to composed safe chats", async () => {
    const fixture = createFixture(undefined, () => ["oc_chat"]);

    await fixture.surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{
        id: "docs",
        name: "Docs",
        cwd: "/workspace/docs",
      }],
    });

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: [
        "## Workspace 已添加",
        "",
        "- Docs · docs",
        "- 工作目录：/workspace/docs",
        "",
        "- 发送 /workspace 可查看并切换 Workspace。",
        "",
        "- 已生效：Workspace",
      ].join("\n"),
    }]);
    expect(fixture.markdowns).toEqual([{
      chatId: "oc_chat",
      text: [
        "## Workspace 已添加",
        "",
        "- Docs · docs",
        "- 工作目录：/workspace/docs",
        "",
        "- 发送 /workspace 可查看并切换 Workspace。",
        "",
        "- 已生效：Workspace",
      ].join("\n"),
    }]);
    await fixture.surface.stop();
  });

  it("notifies the chat when the input queue is overloaded", async () => {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      submit: async () => {
        await gate;
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          steered: false,
        };
      },
    });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    for (let index = 0; index < 110; index += 1) {
      fixture.emitMessage(index);
    }
    await settle();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "当前飞书输入队列繁忙，请稍后重试。",
    }]);

    release();
    await settle();
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let index = 110; index < 220; index += 1) {
      fixture.emitMessage(index);
    }
    await settle();

    expect(fixture.sent).toEqual([
      {
        chatId: "oc_chat",
        text: "当前飞书输入队列繁忙，请稍后重试。",
      },
      {
        chatId: "oc_chat",
        text: "当前飞书输入队列繁忙，请稍后重试。",
      },
    ]);

    release();
    await fixture.surface.stop();
  });

  it("routes an authorized private image through the media port", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const fixture = createFixture({ submit });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitImage();
    await fixture.surface.stop();

    expect(fixture.imageDownload).toHaveBeenCalledWith(
      "om_image",
      "img_v2_resource",
    );
    expect(submit).toHaveBeenCalledWith({
      surface: "feishu",
      accountId: "cli_0123456789abcdef",
      conversationId: "oc_chat",
    }, {
      text: "请查看这张图片并根据图片内容协助我。",
      localImages: [{ path: "/private/uploads/feishu/image.png" }],
    });
  });

  it("routes an authorized private text file through the file port", async () => {
    const submit = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }));
    const fixture = createFixture({ submit });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitFile();
    await fixture.surface.stop();

    expect(fixture.fileDownload).toHaveBeenCalledWith(
      "om_file",
      "file_v2_resource",
      "settings.json",
    );
    expect(submit).toHaveBeenCalledWith({
      surface: "feishu",
      accountId: "cli_0123456789abcdef",
      conversationId: "oc_chat",
    }, [
      "以下内容来自用户通过飞书上传的 UTF-8 文本文件（仅作输入）：",
      "文件名：settings.json",
      "",
      "{\"enabled\":true}",
    ].join("\n"));
  });

  it("reports card callback verification only after observing a valid callback event", async () => {
    const fixture = createFixture();
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMessage(0, "/fs status");
    await settle();
    fixture.emitCardAction();
    fixture.emitMessage(1, "/fs status");
    await fixture.surface.stop();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[0]?.text).toContain(
      "卡片动作回调：尚未验证",
    );
    expect(fixture.sent[1]?.text).toContain(
      "卡片动作回调：已验证",
    );
  });

  it("opens one categorized command center from the bot menu", async () => {
    const fixture = createFixture({}, () => ["oc_chat"]);
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMenuEvent("codexc_home");
    fixture.emitMenuEvent("codexc_home");
    await settle();
    await fixture.surface.stop();

    expect(fixture.cards).toHaveLength(1);
    expect(fixture.cards[0]).toMatchObject({
      chatId: "oc_chat",
      card: expect.objectContaining({
        header: expect.objectContaining({
          title: expect.objectContaining({
            content: "Codex 命令中心",
          }),
        }),
      }),
    });
    expect(fixture.sent).toHaveLength(0);
  });

  it("routes command center buttons through the shared Application command service", async () => {
    const status = vi.fn(() => ({
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      threadId: "thread-1",
      turnId: "turn-1",
      model: "gpt-test",
      effort: "medium",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default" as const,
      collaborationModePending: false,
    }));
    const fixture = createFixture({
      submit: async () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        steered: false,
      }),
      status,
    });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMessage(0, "/start");
    await settle();
    fixture.emitCommandAction("status");
    await settle();
    await fixture.surface.stop();

    expect(status).toHaveBeenCalledWith({
      surface: "feishu",
      accountId: "cli_0123456789abcdef",
      conversationId: "oc_chat",
    }, {
      includeGitBranch: true,
    });
    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: expect.stringContaining("Codex 状态"),
    }]);
  });

  it("opens a Plugin invocation form from the categorized command center", async () => {
    const fixture = createFixture();
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMessage(0, "/start");
    await settle();
    fixture.emitCommandAction("help");
    await settle();
    fixture.emitCommandAction("plugin");
    await settle();
    await fixture.surface.stop();

    expect(fixture.cards).toHaveLength(3);
    expect(JSON.stringify(fixture.cards[2]?.card)).toContain("调用 Plugin");
    expect(JSON.stringify(fixture.cards[2]?.card)).toContain(
      "名称、完整 ID 或序号及任务",
    );
  });

  it("routes a confirmed Doctor card through the application setup controller", async () => {
    const fixture = createFixture(
      undefined,
      undefined,
      undefined,
      {
        grantedTenantScopes: [],
        hasPendingVersion: false,
        messageEventConfigured: false,
        menuEventConfigured: false,
        cardCallbackConfigured: false,
        botMenuEnabled: false,
        menuConfigured: false,
        botMenus: [],
      },
    );
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    fixture.emitMessage(0, "/fs doctor");
    await settle();
    fixture.emitSetupAction();
    await vi.waitFor(() => {
      expect(fixture.updatedCards.length).toBeGreaterThanOrEqual(2);
    });
    await fixture.surface.stop();

    expect(fixture.applicationApi.authorizeApplication)
      .toHaveBeenCalledWith(
        expect.any(AbortSignal),
        expect.any(Function),
        [
          "application:application:self_manage",
          "application:application:patch",
          "im:message:send_as_bot",
          "im:resource",
          "im:message:readonly",
          "cardkit:card:write",
        ],
      );
    expect(JSON.stringify(fixture.updatedCards.at(-1)?.card))
      .toContain("飞书官方授权已完成");
  });
});

function createFixture(
  service: Partial<ConversationUseCases> | undefined = undefined,
  configurationRecipients?: () => readonly string[],
  startupNotification?: {
    messages(): ReadonlyArray<{ chatId: string; text: string }>;
  },
  applicationSnapshot: FeishuApplicationSnapshot = {
    grantedTenantScopes: [
      "application:application:self_manage",
      "application:application:patch",
      "im:message:send_as_bot",
      "im:resource",
      "im:message:readonly",
      "cardkit:card:write",
    ],
    hasPendingVersion: false,
    messageEventConfigured: true,
    menuEventConfigured: true,
    cardCallbackConfigured: true,
    botMenuEnabled: true,
    menuConfigured: true,
    botMenuDisplayStrategy: 3,
    botMenus: [],
  },
) {
  const conversationService = ({
    submit: async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }),
    ...service,
  }) as ConversationUseCases;
  let readyCallback: (() => void) | undefined;
  let reconnectingCallback: (() => void) | undefined;
  let reconnectedCallback: (() => void) | undefined;
  let messageHandler: ((event: unknown) => void) | undefined;
  let cardActionHandler: ((event: unknown) => void) | undefined;
  let menuEventHandler: ((event: unknown) => void) | undefined;
  const sent: Array<{ chatId: string; text: string }> = [];
  const markdowns: Array<{ chatId: string; text: string }> = [];
  const cards: Array<{
    chatId: string;
    messageId: string;
    card: FeishuCardDocument;
  }> = [];
  const updatedCards: Array<{
    messageId: string;
    card: FeishuCardDocument;
  }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const sdkStart = vi.fn(async () => {});
  const sdkClose = vi.fn();
  const imageDownload = vi.fn(async () => ({
    path: "/private/uploads/feishu/image.png",
    mimeType: "image/png" as const,
    bytes: 8,
  }));
  const fileDownload = vi.fn(async () => ({
    fileName: "settings.json",
    text: "{\"enabled\":true}",
    bytes: 16,
  }));
  const oauthClose = vi.fn(async () => {});
  const applicationApi = {
    inspect: vi.fn(async () => applicationSnapshot),
    configureApplication: vi.fn(async () => ({
      changed: true,
      versionId: "oav_new",
    })),
    authorizeApplication: vi.fn(
      async (
        _signal: AbortSignal,
        ready: (url: string, expiresInSeconds: number) => void,
      ) => {
        ready(
          "https://applink.feishu.cn/client/mini_program/open?code=one",
          600,
        );
      },
    ),
  };
  const logger = pino({ level: "info" }, {
    write(message) {
      logs.push(JSON.parse(message) as Record<string, unknown>);
    },
  });
  const surface = new FeishuSurface({
    appId: "cli_0123456789abcdef",
    appSecret: "secret",
    service: conversationService,
    access: {
      isAllowed: () => true,
    },
    actorRegistry: {
      actors: () => ["ou_actor"],
      rememberActor: () => {},
    },
    logger,
    uploadsDirectory: "/private/uploads/feishu",
    credentialsDirectory: "/private/credentials/feishu",
    onFatal: vi.fn(),
    ...(configurationRecipients ? { configurationRecipients } : {}),
    ...(startupNotification ? { startupNotification } : {}),
  }, {
    messagePort: {
      sendCard: async (chatId, card) => {
        const messageId = `om_card_${cards.length + 1}`;
        cards.push({ chatId, messageId, card });
        return messageId;
      },
      updateCard: async (messageId, card) => {
        updatedCards.push({ messageId, card });
      },
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendPost: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      sendMarkdownCard: async (chatId, text) => {
        sent.push({ chatId, text });
        markdowns.push({ chatId, text });
      },
      createStreamingCard: async () => ({
        cardId: "735537276613415731",
        messageId: "om_stream",
      }),
      updateStreamingCard: async () => {},
      finishStreamingCard: async () => {},
    },
    imagePort: {
      start: async () => {},
      close: () => {},
      download: imageDownload,
    },
    audioPort: {
      start: async () => {},
      close: () => {},
      download: async () => ({
        path: "/private/uploads/feishu/audio.mp3",
        mimeType: "audio/mpeg",
        bytes: 8,
      }),
    },
    filePort: {
      download: fileDownload,
    },
    createEventConnection: (options) => new FeishuEventConnection(
      options,
      {
        startupTimeoutMs: 1_000,
        createSdkConnection: (_credentials, callbacks) => {
          readyCallback = callbacks.onReady;
          reconnectingCallback = callbacks.onReconnecting;
          reconnectedCallback = callbacks.onReconnected;
          return {
            registerMessageHandler(handler) {
              messageHandler = handler;
            },
            registerCardActionHandler(handler) {
              cardActionHandler = handler;
            },
            registerMenuEventHandler(handler) {
              menuEventHandler = handler;
            },
            start: sdkStart,
            close: sdkClose,
          };
        },
      },
    ),
    oauth: {
      beginAuthorization: () => "started",
      status: async () => "missing",
      revoke: async () => false,
      close: oauthClose,
    },
    applicationApi,
  });
  return {
    surface,
    sent,
    markdowns,
    cards,
    updatedCards,
    logs,
    sdkStart,
    sdkClose,
    imageDownload,
    fileDownload,
    oauthClose,
    applicationApi,
    ready() {
      if (!readyCallback) {
        throw new Error("飞书 SDK 尚未注册 ready 回调");
      }
      readyCallback();
    },
    reconnecting() {
      if (!reconnectingCallback) {
        throw new Error("飞书 SDK 尚未注册 reconnecting 回调");
      }
      reconnectingCallback();
    },
    reconnected() {
      if (!reconnectedCallback) {
        throw new Error("飞书 SDK 尚未注册 reconnected 回调");
      }
      reconnectedCallback();
    },
    emitMessage(index = 0, text = "继续开发") {
      if (!messageHandler) {
        throw new Error("飞书 SDK 尚未注册消息处理器");
      }
      messageHandler({
        event_id: `event-${index}`,
        sender: {
          sender_id: {
            open_id: "ou_actor",
          },
          sender_type: "user",
        },
        message: {
          message_id: `om_message_${index}`,
          create_time: String(Date.now()),
          chat_id: "oc_chat",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    },
    emitCardAction() {
      if (!cardActionHandler) {
        throw new Error("飞书 SDK 尚未注册卡片动作处理器");
      }
      cardActionHandler({
        context: {
          open_message_id: "om_unknown_card",
          open_chat_id: "oc_chat",
        },
        operator: {
          open_id: "ou_actor",
        },
        action: {
          tag: "button",
          value: {
            interaction_token: "unknown-token",
            decision: "reject",
          },
        },
      });
    },
    emitMenuEvent(
      eventKey = "codexc_home",
      eventId = "event-menu-1",
    ) {
      if (!menuEventHandler) {
        throw new Error("飞书 SDK 尚未注册机器人菜单处理器");
      }
      menuEventHandler({
        event_id: eventId,
        app_id: "cli_0123456789abcdef",
        operator: {
          operator_id: {
            open_id: "ou_actor",
          },
        },
        event_key: eventKey,
      });
    },
    emitCommandAction(command: string) {
      if (!cardActionHandler) {
        throw new Error("飞书 SDK 尚未注册卡片动作处理器");
      }
      const sentCard = cards.at(-1);
      if (!sentCard) {
        throw new Error("飞书命令中心卡片尚未发送");
      }
      const value = feishuCardElements(sentCard.card).flatMap((element) =>
        Array.isArray(element.actions) ? element.actions : [],
      ).flatMap((action) => {
        if (
          typeof action !== "object"
          || action === null
          || !("value" in action)
        ) {
          return [];
        }
        const candidate = (action as {
          value: Record<string, string>;
        }).value;
        return candidate.codexc_command === command ? [candidate] : [];
      })[0];
      if (!value) {
        throw new Error("飞书命令中心动作不存在");
      }
      cardActionHandler({
        context: {
          open_message_id: sentCard.messageId,
          open_chat_id: sentCard.chatId,
        },
        operator: {
          open_id: "ou_actor",
        },
        action: {
          tag: "button",
          value,
        },
      });
    },
    emitSetupAction() {
      if (!cardActionHandler) {
        throw new Error("飞书 SDK 尚未注册卡片动作处理器");
      }
      const sentCard = cards.find((entry) =>
        JSON.stringify(entry.card).includes("codexc_feishu_setup_token")
      );
      if (!sentCard) {
        throw new Error("飞书 Doctor 配置卡片尚未发送");
      }
      const value = feishuCardElements(sentCard.card).flatMap((element) =>
        Array.isArray(element.actions) ? element.actions : [],
      ).flatMap((action) => {
        if (
          typeof action !== "object"
          || action === null
          || !("value" in action)
        ) {
          return [];
        }
        const candidate = (action as {
          value: Record<string, string>;
        }).value;
        return candidate.codexc_feishu_setup_action === "authorize"
          ? [candidate]
          : [];
      })[0];
      if (!value) {
        throw new Error("飞书 Doctor 授权动作不存在");
      }
      cardActionHandler({
        context: {
          open_message_id: sentCard.messageId,
          open_chat_id: sentCard.chatId,
        },
        operator: {
          open_id: "ou_actor",
        },
        action: {
          tag: "button",
          value,
        },
      });
    },
    emitImage() {
      if (!messageHandler) {
        throw new Error("飞书 SDK 尚未注册消息处理器");
      }
      messageHandler({
        event_id: "event-image",
        sender: {
          sender_id: {
            open_id: "ou_actor",
          },
          sender_type: "user",
        },
        message: {
          message_id: "om_image",
          create_time: String(Date.now()),
          chat_id: "oc_chat",
          chat_type: "p2p",
          message_type: "image",
          content: "{\"image_key\":\"img_v2_resource\"}",
        },
      });
    },
    emitFile() {
      if (!messageHandler) {
        throw new Error("飞书 SDK 尚未注册消息处理器");
      }
      messageHandler({
        event_id: "event-file",
        sender: {
          sender_id: {
            open_id: "ou_actor",
          },
          sender_type: "user",
        },
        message: {
          message_id: "om_file",
          create_time: String(Date.now()),
          chat_id: "oc_chat",
          chat_type: "p2p",
          message_type: "file",
          content: JSON.stringify({
            file_key: "file_v2_resource",
            file_name: "settings.json",
          }),
        },
      });
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
