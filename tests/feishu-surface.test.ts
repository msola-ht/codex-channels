import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import {
  FeishuEventConnection,
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
      text: "Gateway 配置已热加载\n新增 Workspace：Docs",
    }]);
    await fixture.surface.stop();
  });

  it("notifies the chat when the input queue is overloaded", async () => {
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
          steered: false,
        };
      },
    });
    const starting = fixture.surface.start();
    fixture.ready();
    await starting;

    for (let index = 0; index <= 100; index += 1) {
      fixture.emitMessage(index);
    }
    await settle();

    expect(fixture.sent).toEqual([{
      chatId: "oc_chat",
      text: "当前飞书输入队列繁忙，请稍后重试。",
    }]);

    release();
    await fixture.surface.stop();
  });
});

function createFixture(
  service: Pick<ConversationService, "submit"> | undefined = undefined,
  configurationRecipients?: () => readonly string[],
) {
  const conversationService = service ?? {
    submit: async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }),
  };
  let readyCallback: (() => void) | undefined;
  let reconnectingCallback: (() => void) | undefined;
  let reconnectedCallback: (() => void) | undefined;
  let messageHandler: ((event: unknown) => void) | undefined;
  const sent: Array<{ chatId: string; text: string }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const sdkStart = vi.fn(async () => {});
  const sdkClose = vi.fn();
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
    logger,
    onFatal: vi.fn(),
    ...(configurationRecipients ? { configurationRecipients } : {}),
  }, {
    messagePort: {
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
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
            start: sdkStart,
            close: sdkClose,
          };
        },
      },
    ),
  });
  return {
    surface,
    sent,
    logs,
    sdkStart,
    sdkClose,
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
    emitMessage(index = 0) {
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
          content: "{\"text\":\"继续开发\"}",
        },
      });
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
