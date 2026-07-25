import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import {
  FeishuEventConnection,
} from "../src/surfaces/feishu/index.js";
import { FeishuSurface } from "../src/surfaces/feishu/surface.js";

describe("Feishu Surface", () => {
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
  service: Pick<ConversationService, "submit"> = {
    submit: async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    }),
  },
) {
  let readyCallback: (() => void) | undefined;
  let messageHandler: ((event: unknown) => void) | undefined;
  const sent: Array<{ chatId: string; text: string }> = [];
  const sdkStart = vi.fn(async () => {});
  const sdkClose = vi.fn();
  const surface = new FeishuSurface({
    appId: "cli_0123456789abcdef",
    appSecret: "secret",
    service,
    access: {
      isAllowed: () => true,
    },
    logger: pino({ level: "silent" }),
    onFatal: vi.fn(),
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
    sdkStart,
    sdkClose,
    ready() {
      if (!readyCallback) {
        throw new Error("飞书 SDK 尚未注册 ready 回调");
      }
      readyCallback();
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
