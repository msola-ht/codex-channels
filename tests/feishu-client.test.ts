import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFeishuHttpPolicy,
  FeishuMessageError,
  FeishuMessageClient,
} from "../src/surfaces/feishu/client.js";
import {
  FeishuConnectionError,
  FeishuEventConnection,
  type FeishuConnectionState,
} from "../src/surfaces/feishu/event-connection.js";
import type {
  HttpInstance,
} from "@larksuiteoapi/node-sdk";
import type {
  FeishuCardDocument,
} from "../src/surfaces/feishu/approval-card.js";

interface FakeCallbacks {
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

function createFixture(startupTimeoutMs = 1_000) {
  let callbacks: FakeCallbacks | undefined;
  let messageHandler: ((event: unknown) => void) | undefined;
  let cardActionHandler: ((event: unknown) => void) | undefined;
  let menuEventHandler: ((event: unknown) => void) | undefined;
  const start = vi.fn(async () => {});
  const close = vi.fn();
  const onMessage = vi.fn();
  const onInvalidMessage = vi.fn();
  const onCardAction = vi.fn();
  const onInvalidCardAction = vi.fn();
  const onMenuEvent = vi.fn();
  const onInvalidMenuEvent = vi.fn();
  const onReconnecting = vi.fn();
  const onReconnected = vi.fn();
  const onFatal = vi.fn();
  const connection = new FeishuEventConnection(
    {
      appId: "cli_0123456789abcdef",
      appSecret: "secret",
      onMessage,
      onInvalidMessage,
      onCardAction,
      onInvalidCardAction,
      onMenuEvent,
      onInvalidMenuEvent,
      onReconnecting,
      onReconnected,
      onFatal,
    },
    {
      startupTimeoutMs,
      createSdkConnection: (_options, nextCallbacks) => {
        callbacks = nextCallbacks;
        return {
          registerMessageHandler: (handler) => {
            messageHandler = handler;
          },
          registerCardActionHandler: (handler) => {
            cardActionHandler = handler;
          },
          registerMenuEventHandler: (handler) => {
            menuEventHandler = handler;
          },
          start,
          close,
        };
      },
    },
  );
  return {
    connection,
    start,
    close,
    onMessage,
    onInvalidMessage,
    onCardAction,
    onInvalidCardAction,
    onMenuEvent,
    onInvalidMenuEvent,
    onReconnecting,
    onReconnected,
    onFatal,
    get callbacks() {
      if (callbacks === undefined) {
        throw new Error("SDK callbacks are not registered");
      }
      return callbacks;
    },
    emitMessage(event: unknown) {
      if (messageHandler === undefined) {
        throw new Error("message handler is not registered");
      }
      messageHandler(event);
    },
    emitCardAction(event: unknown) {
      if (cardActionHandler === undefined) {
        throw new Error("card action handler is not registered");
      }
      cardActionHandler(event);
    },
    emitMenuEvent(event: unknown) {
      if (menuEventHandler === undefined) {
        throw new Error("menu event handler is not registered");
      }
      menuEventHandler(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Feishu HTTP policy", () => {
  it("applies timeout, cancellation, and the selected proxy agent", async () => {
    const request = vi.fn<(options: unknown) => Promise<unknown>>(
      async () => ({}),
    );
    const agent = {};
    const signal = new AbortController().signal;
    const http = applyFeishuHttpPolicy(
      { request } as unknown as HttpInstance,
      15_000,
      agent,
    );

    await http.request({
      url: "https://open.feishu.cn/open-apis/test",
      method: "GET",
      signal,
    } as never);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 15_000,
      signal,
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
    }));
  });

  it("disables Axios environment proxy discovery for an explicit direct route", async () => {
    const request = vi.fn<(options: unknown) => Promise<unknown>>(
      async () => ({}),
    );
    const http = applyFeishuHttpPolicy(
      { request } as unknown as HttpInstance,
      15_000,
      undefined,
      true,
    );

    await http.request({
      url: "https://open.feishu.cn/open-apis/test",
      method: "GET",
    } as never);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 15_000,
      proxy: false,
    }));
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("httpAgent");
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("httpsAgent");
  });
});

describe("FeishuEventConnection", () => {
  it("rejects invalid credentials before creating the SDK connection", async () => {
    const createSdkConnection = vi.fn();
    const connection = new FeishuEventConnection(
      {
        appId: "invalid",
        appSecret: "",
        onMessage: vi.fn(),
        onInvalidMessage: vi.fn(),
        onFatal: vi.fn(),
      },
      {
        startupTimeoutMs: 1_000,
        createSdkConnection,
      },
    );

    await expect(connection.start()).rejects.toMatchObject({
      code: "invalid-credentials",
    });
    expect(connection.state).toBe("failed");
    expect(createSdkConnection).not.toHaveBeenCalled();
  });

  it("waits for onReady and shares concurrent start calls", async () => {
    const fixture = createFixture();

    const firstStart = fixture.connection.start();
    const secondStart = fixture.connection.start();

    expect(firstStart).toBe(secondStart);
    expect(fixture.connection.state).toBe("starting");
    expect(fixture.start).toHaveBeenCalledOnce();

    fixture.callbacks.onReady();

    await expect(firstStart).resolves.toBeUndefined();
    expect(fixture.connection.state).toBe("running");
  });

  it("rejects an initial SDK error without exposing its details", async () => {
    const fixture = createFixture();
    const startPromise = fixture.connection.start();

    fixture.callbacks.onError(new Error("secret response body"));

    await expect(startPromise).rejects.toEqual(new FeishuConnectionError(
      "start-failed",
      "飞书长连接启动失败",
    ));
    expect(fixture.connection.state).toBe("failed");
    expect(fixture.close).toHaveBeenCalledWith(true);
    expect(fixture.onFatal).not.toHaveBeenCalled();
  });

  it("reports a sanitized fatal error after the connection was ready", async () => {
    const fixture = createFixture();
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    fixture.callbacks.onError(new Error("secret response body"));

    expect(fixture.connection.state).toBe("failed");
    expect(fixture.onFatal).toHaveBeenCalledWith(new FeishuConnectionError(
      "start-failed",
      "飞书长连接运行失败",
    ));
    expect(fixture.close).toHaveBeenCalledWith(true);

    await fixture.connection.stop();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("tracks reconnect lifecycle without resolving a second start", async () => {
    const fixture = createFixture();
    const states: FeishuConnectionState[] = [];
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    fixture.callbacks.onReconnecting();
    states.push(fixture.connection.state);
    await expect(fixture.connection.start()).resolves.toBeUndefined();
    fixture.callbacks.onReconnected();
    states.push(fixture.connection.state);

    expect(states).toEqual(["reconnecting", "running"]);
    expect(fixture.onReconnecting).toHaveBeenCalledOnce();
    expect(fixture.onReconnected).toHaveBeenCalledOnce();
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it("does not let lifecycle observers interrupt the SDK reader", async () => {
    const fixture = createFixture();
    fixture.onReconnecting.mockImplementation(() => {
      throw new Error("logger failed");
    });
    fixture.onReconnected.mockImplementation(() => {
      throw new Error("logger failed");
    });
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    expect(() => fixture.callbacks.onReconnecting()).not.toThrow();
    expect(fixture.connection.state).toBe("reconnecting");
    expect(() => fixture.callbacks.onReconnected()).not.toThrow();
    expect(fixture.connection.state).toBe("running");
  });

  it("forwards messages only while active", async () => {
    const fixture = createFixture();
    const event = {
      event_id: "event-1",
      sender: {
        sender_id: {
          open_id: "ou_actor",
        },
        sender_type: "user",
      },
      message: {
        message_id: "om_message",
        create_time: "1784900000000",
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        content: "{\"text\":\"hello\"}",
      },
    };
    const startPromise = fixture.connection.start();

    fixture.emitMessage(event);
    expect(fixture.onMessage).not.toHaveBeenCalled();

    fixture.callbacks.onReady();
    await startPromise;
    fixture.emitMessage(event);
    expect(fixture.onMessage).toHaveBeenCalledWith({
      eventId: "event-1",
      actorOpenId: "ou_actor",
      senderType: "user",
      messageId: "om_message",
      createTime: "1784900000000",
      chatId: "oc_chat",
      chatType: "p2p",
      messageType: "text",
      content: "{\"text\":\"hello\"}",
    });

    await fixture.connection.stop();
    fixture.emitMessage(event);
    expect(fixture.onMessage).toHaveBeenCalledOnce();
  });

  it("acknowledges malformed SDK events through a stable diagnostic callback", async () => {
    const fixture = createFixture();
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    expect(() => {
      fixture.emitMessage({ event_id: "event-1" });
    }).not.toThrow();
    expect(fixture.onMessage).not.toHaveBeenCalled();
    expect(fixture.onInvalidMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "invalid-message-event",
        field: "sender",
      }),
    );
  });

  it("routes valid card actions only while active", async () => {
    const fixture = createFixture();
    const action = {
      context: {
        open_message_id: "om_message",
        open_chat_id: "oc_chat",
      },
      operator: {
        open_id: "ou_actor",
      },
      action: {
        tag: "button",
        value: {
          interaction_token: "opaque-token",
          decision: "approve-once",
        },
        form_value: {
          q0: "answer",
        },
      },
    };
    const startPromise = fixture.connection.start();

    fixture.emitCardAction(action);
    expect(fixture.onCardAction).not.toHaveBeenCalled();

    fixture.callbacks.onReady();
    await startPromise;
    fixture.emitCardAction(action);
    expect(fixture.onCardAction).toHaveBeenCalledWith({
      messageId: "om_message",
      chatId: "oc_chat",
      actorOpenId: "ou_actor",
      tag: "button",
      value: {
        interaction_token: "opaque-token",
        decision: "approve-once",
      },
      formValues: {
        q0: "answer",
      },
    });

    await fixture.connection.stop();
    fixture.emitCardAction(action);
    expect(fixture.onCardAction).toHaveBeenCalledOnce();
  });

  it("reports malformed card actions without throwing into the SDK reader", async () => {
    const fixture = createFixture();
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    expect(() => fixture.emitCardAction({})).not.toThrow();
    expect(fixture.onCardAction).not.toHaveBeenCalled();
    expect(fixture.onInvalidCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "invalid-card-action",
        field: "context",
      }),
    );
  });

  it("routes strict bot menu events only while active", async () => {
    const fixture = createFixture();
    const event = {
      event_id: "event-menu-1",
      app_id: "cli_0123456789abcdef",
      operator: {
        operator_id: {
          open_id: "ou_actor",
        },
      },
      event_key: "codexc_home",
    };
    const startPromise = fixture.connection.start();

    fixture.emitMenuEvent(event);
    expect(fixture.onMenuEvent).not.toHaveBeenCalled();

    fixture.callbacks.onReady();
    await startPromise;
    fixture.emitMenuEvent(event);
    expect(fixture.onMenuEvent).toHaveBeenCalledWith({
      eventId: "event-menu-1",
      appId: "cli_0123456789abcdef",
      actorOpenId: "ou_actor",
      eventKey: "codexc_home",
    });

    await fixture.connection.stop();
    fixture.emitMenuEvent(event);
    expect(fixture.onMenuEvent).toHaveBeenCalledOnce();
  });

  it("reports malformed bot menu events without throwing into the SDK reader", async () => {
    const fixture = createFixture();
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    expect(() => fixture.emitMenuEvent({
      event_id: "event-menu-1",
      app_id: "cli_0123456789abcdef",
      operator: {},
      event_key: "codexc_home",
    })).not.toThrow();
    expect(fixture.onMenuEvent).not.toHaveBeenCalled();
    expect(fixture.onInvalidMenuEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "invalid-menu-event",
        field: "operator.operator_id",
      }),
    );
  });

  it("does not retry malformed events when diagnostics fail", async () => {
    const fixture = createFixture();
    fixture.onInvalidMessage.mockImplementation(() => {
      throw new Error("logger failed");
    });
    const startPromise = fixture.connection.start();
    fixture.callbacks.onReady();
    await startPromise;

    expect(() => {
      fixture.emitMessage({ event_id: "event-1" });
    }).not.toThrow();
    expect(fixture.onMessage).not.toHaveBeenCalled();
  });

  it("stops a pending start and closes the socket once", async () => {
    const fixture = createFixture();
    const startPromise = fixture.connection.start();

    await fixture.connection.stop();
    await fixture.connection.stop();

    await expect(startPromise).rejects.toMatchObject({ code: "stopped" });
    expect(fixture.connection.state).toBe("stopped");
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledWith(true);
  });

  it("times out a handshake and force-closes the SDK client", async () => {
    vi.useFakeTimers();
    const fixture = createFixture(250);
    const startPromise = fixture.connection.start();
    const rejection = expect(startPromise).rejects.toMatchObject({
      code: "start-timeout",
    });

    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(fixture.connection.state).toBe("failed");
    expect(fixture.close).toHaveBeenCalledWith(true);
  });
});

describe("FeishuMessageClient", () => {
  it("rejects invalid credentials before creating the SDK client", () => {
    const createSdkClient = vi.fn();

    expect(() => new FeishuMessageClient(
      {
        appId: "invalid",
        appSecret: "",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient,
      },
    )).toThrow(new FeishuMessageError(
      "invalid-credentials",
      "飞书应用凭据格式无效",
    ));
    expect(createSdkClient).not.toHaveBeenCalled();
  });

  it("hides SDK client creation error details", () => {
    expect(() => new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => {
          throw new Error("appSecret=secret");
        },
      },
    )).toThrow(new FeishuMessageError(
      "client-create-failed",
      "飞书消息客户端创建失败",
    ));
  });

  it("sends a text message to an exact chat ID", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_message" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).resolves.toBeUndefined();

    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: "{\"text\":\"飞书回复\"}",
      },
    });
  });

  it("sends Markdown as a Feishu rich-text post to an exact chat ID", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_message" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendPost("oc_chat", "**状态**\n\n- 正常"),
    ).resolves.toBeUndefined();

    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "",
            content: [[{
              tag: "md",
              text: "**状态**\n\n- 正常",
            }]],
          },
        }),
      },
    });
  });

  it("uploads and sends a generated text file to an exact chat ID", async () => {
    const createFile = vi.fn(async () => ({
      file_key: "file_final_answer",
    }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_file" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createFile,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );
    const file = Buffer.from("完整回复", "utf8");

    await expect(
      client.sendFile("oc_chat", "codex-final-answer.txt", file),
    ).resolves.toBeUndefined();

    expect(createFile).toHaveBeenCalledWith({
      data: {
        file_type: "stream",
        file_name: "codex-final-answer.txt",
        file,
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "file",
        content: "{\"file_key\":\"file_final_answer\"}",
      },
    });
  });

  it("fails closed when a file upload omits its file key", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_file" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createFile: async () => ({}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendFile(
        "oc_chat",
        "codex-final-answer.txt",
        Buffer.from("完整回复", "utf8"),
      ),
    ).rejects.toMatchObject({
      name: "FeishuMessageError",
      code: "invalid-response",
      message: "飞书文件上传响应无效",
    });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("uploads and sends a generated image to an exact chat ID", async () => {
    const createImage = vi.fn(async () => ({
      image_key: "img_generated",
    }));
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_image" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createImage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );
    const image = Buffer.from("validated-image");

    await expect(
      client.sendImage("oc_chat", image),
    ).resolves.toBeUndefined();

    expect(createImage).toHaveBeenCalledWith({
      data: {
        image_type: "message",
        image,
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "image",
        content: "{\"image_key\":\"img_generated\"}",
      },
    });
  });

  it("fails closed when an image upload omits its image key", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_image" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createImage: async () => ({}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendImage("oc_chat", Buffer.from("validated-image")),
    ).rejects.toMatchObject({
      name: "FeishuMessageError",
      code: "invalid-response",
      message: "飞书图片上传响应无效",
    });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("replies to an exact Feishu message with a Markdown CardKit card", async () => {
    const replyMessage = vi.fn(async () => ({
      data: { message_id: "om_reply" },
    }));
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          replyMessage,
          patchMessage: successfulPatch,
          createStreamingCard,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.replyMarkdownCard("om_origin", "**已开始处理。**"),
    ).resolves.toBeUndefined();

    expect(replyMessage).toHaveBeenCalledWith({
      path: { message_id: "om_origin" },
      data: {
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "7355372766134157313",
          },
        }),
        reply_in_thread: false,
      },
    });
  });

  it("creates and sends a native streaming CardKit card", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_stream" },
    }));
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.createStreamingCard("oc_chat", "开始回答"),
    ).resolves.toEqual({
      cardId: "7355372766134157313",
      messageId: "om_stream",
    });

    expect(createStreamingCard).toHaveBeenCalledWith({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          config: {
            streaming_mode: true,
            summary: {
              content: "生成中",
            },
            streaming_config: {
              print_frequency_ms: {
                default: 70,
              },
              print_step: {
                default: 1,
              },
              print_strategy: "fast",
            },
          },
          body: {
            elements: [{
              tag: "markdown",
              element_id: "codexc_stream",
              content: "开始回答",
            }],
          },
        }),
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "7355372766134157313",
          },
        }),
      },
    });
  });

  it("creates and sends a static CardKit Markdown card", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_static" },
    }));
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendMarkdownCard("oc_chat", "**状态**\n\n- 正常"),
    ).resolves.toBeUndefined();

    expect(createStreamingCard).toHaveBeenCalledWith({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          config: {
            summary: {
              content: "**状态** - 正常",
            },
          },
          body: {
            elements: [{
              tag: "markdown",
              content: "**状态**\n\n- 正常",
            }],
          },
        }),
      },
    });
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: {
            card_id: "7355372766134157313",
          },
        }),
      },
    });
  });

  it("reports a stable error before message send when static CardKit creation fails", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_fallback" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          createStreamingCard: async () => {
            throw new Error("card create failed");
          },
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.sendMarkdownCard("oc_chat", "**状态**\n\n- 正常"),
    ).rejects.toMatchObject({
      code: "card-create-failed",
      message: "飞书静态卡片创建失败",
    });

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("neutralizes platform-native mentions in every static CardKit field", async () => {
    const createStreamingCard = vi.fn(async () => ({
      code: 0,
      data: { card_id: "7355372766134157313" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_static" },
          }),
          createStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.sendMarkdownCard(
      "oc_chat",
      "<at user_id=\"all\">所有人</at>",
    );

    expect(JSON.stringify(createStreamingCard.mock.calls))
      .not.toContain("<at");
    expect(JSON.stringify(createStreamingCard.mock.calls))
      .toContain("&lt;at");
  });

  it("updates and finishes a native streaming CardKit card in sequence", async () => {
    const updateStreamingCard = vi.fn(async () => ({ code: 0 }));
    const finishStreamingCard = vi.fn(async (payload: {
      path: { card_id: string };
      data: {
        card: { type: "card_json"; data: string };
        sequence: number;
        uuid: string;
      };
    }) => {
      void payload;
      return { code: 0 };
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          finishStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "完整正文", 1),
    ).resolves.toBeUndefined();
    await expect(
      client.finishStreamingCard("7355372766134157313", 2, "完整正文"),
    ).resolves.toBeUndefined();

    expect(updateStreamingCard).toHaveBeenCalledWith({
      path: {
        card_id: "7355372766134157313",
        element_id: "codexc_stream",
      },
      data: {
        content: "完整正文",
        sequence: 1,
        uuid: "c_7355372766134157313_1",
      },
    });
    expect(finishStreamingCard).toHaveBeenCalledWith({
      path: {
        card_id: "7355372766134157313",
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
            config: {
              streaming_mode: false,
              summary: {
                content: "完整正文",
              },
            },
            body: {
              elements: [{
                tag: "markdown",
                element_id: "codexc_stream",
                content: "完整正文",
              }],
            },
          }),
        },
        sequence: 2,
        uuid: "f_7355372766134157313_2",
      },
    });
  });

  it("finalizes a streaming card with the complete static markdown body", async () => {
    const finishStreamingCard = vi.fn(async () => ({ code: 0 }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          finishStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.finishStreamingCard(
      "7355372766134157313",
      2,
      "结尾不能少字：尚未推送。",
      "**本次运行 · 已完成**",
    );

    expect(finishStreamingCard).toHaveBeenCalledWith({
      path: {
        card_id: "7355372766134157313",
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
            config: {
              streaming_mode: false,
              summary: {
                content: "结尾不能少字：尚未推送。",
              },
            },
            body: {
              elements: [
                {
                  tag: "markdown",
                  element_id: "codexc_stream",
                  content: "结尾不能少字：尚未推送。",
                },
                {
                  tag: "hr",
                },
                {
                  tag: "markdown",
                  content: "**本次运行 · 已完成**",
                },
              ],
            },
          }),
        },
        sequence: 2,
        uuid: "f_7355372766134157313_2",
      },
    });
  });

  it("maps CardKit update failures to a stable response error", async () => {
    const updateStreamingCard = vi.fn(async () => ({
      code: 99_999,
      message: "app_secret=secret",
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "正文", 1),
    ).rejects.toEqual(new FeishuMessageError(
      "invalid-response",
      "飞书流式卡片更新响应无效",
    ));
  });

  it("classifies CardKit rate limits without exposing the SDK response", async () => {
    const updateStreamingCard = vi.fn(async () => ({
      code: 99991400,
      message: "app_secret=secret",
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "正文", 1),
    ).rejects.toEqual(new FeishuMessageError(
      "rate-limited",
      "飞书流式卡片更新请求受限",
    ));
  });

  it("classifies HTTP 429 CardKit failures without exposing the response", async () => {
    const updateStreamingCard = vi.fn(async () => {
      throw {
        response: {
          status: 429,
          data: {
            message: "app_secret=secret",
          },
        },
      };
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          updateStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateStreamingCard("7355372766134157313", "正文", 1),
    ).rejects.toEqual(new FeishuMessageError(
      "rate-limited",
      "飞书流式卡片更新请求受限",
    ));
  });

  it("keeps a streaming summary within fifty UTF-16 code units", async () => {
    const finishStreamingCard = vi.fn(async (payload: {
      path: { card_id: string };
      data: {
        card: { type: "card_json"; data: string };
        sequence: number;
        uuid: string;
      };
    }) => {
      void payload;
      return { code: 0 };
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          finishStreamingCard,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.finishStreamingCard(
      "7355372766134157313",
      1,
      "😀".repeat(60),
    );

    const payload = finishStreamingCard.mock.calls[0]?.[0];
    const card = JSON.parse(payload?.data.card.data ?? "{}") as {
      config?: { summary?: { content?: string } };
    };
    expect(card.config?.summary?.content).toBe(
      `${"😀".repeat(24)}…`,
    );
    expect(card.config?.summary?.content?.length).toBeLessThanOrEqual(50);
  });

  it("creates and updates an interactive card without retrying", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_card" },
    }));
    const patchMessage = vi.fn(async () => ({ code: 0 }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage,
          downloadResource: successfulDownload,
        }),
      },
    );
    const card = approvalCard();

    await expect(client.sendCard("oc_chat", card)).resolves.toBe("om_card");
    await expect(client.updateCard("om_card", card)).resolves.toBeUndefined();

    expect(createMessage).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    expect(patchMessage).toHaveBeenCalledOnce();
    expect(patchMessage).toHaveBeenCalledWith({
      path: {
        message_id: "om_card",
      },
      data: {
        content: JSON.stringify(card),
      },
    });
  });

  it("fails closed when a message update response reports an error", async () => {
    const patchMessage = vi.fn(async () => ({ code: 999 }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateCard("om_status", approvalCard()),
    ).rejects.toEqual(new FeishuMessageError(
      "invalid-response",
      "飞书消息更新响应无效",
    ));
    expect(patchMessage).toHaveBeenCalledOnce();
  });

  it("hides SDK error details from a message update", async () => {
    const patchMessage = vi.fn(async () => {
      throw new Error("Authorization: secret");
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateCard("om_status", approvalCard()),
    ).rejects.toEqual(new FeishuMessageError(
      "send-failed",
      "飞书消息更新失败",
    ));
    expect(patchMessage).toHaveBeenCalledOnce();
  });

  it("maps an SDK HTTP update timeout to the stable timeout error", async () => {
    const timeout = Object.assign(new Error("request secret"), {
      code: "ECONNABORTED",
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage: async () => {
            throw timeout;
          },
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(
      client.updateCard("om_status", approvalCard()),
    ).rejects.toEqual(new FeishuMessageError(
      "send-timeout",
      "飞书消息更新超时",
    ));
  });

  it("fails with a sanitized timeout when a message update hangs", async () => {
    vi.useFakeTimers();
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 250,
        createSdkClient: () => ({
          createMessage: async () => ({
            data: { message_id: "om_message" },
          }),
          patchMessage: () => new Promise(() => {}),
          downloadResource: successfulDownload,
        }),
      },
    );

    const updating = client.updateCard(
      "om_status",
      approvalCard(),
    );
    const rejection = expect(updating).rejects.toEqual(
      new FeishuMessageError(
        "send-timeout",
        "飞书消息更新超时",
      ),
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });

  it("neutralizes platform-native mention tags in rich Markdown", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_message" },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await client.sendPost(
      "oc_chat",
      "<at user_id=\"all\">所有人</at>",
    );

    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "",
            content: [[{
              tag: "md",
              text: "&lt;at user_id=\"all\">所有人&lt;/at>",
            }]],
          },
        }),
      },
    });
  });

  it("fails with a sanitized timeout when sending takes too long", async () => {
    vi.useFakeTimers();
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 250,
        createSdkClient: () => ({
          createMessage: () => new Promise(() => {}),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    const sending = client.sendText("oc_chat", "飞书回复");
    const rejection = expect(sending).rejects.toEqual(
      new FeishuMessageError(
        "send-timeout",
        "飞书消息发送超时",
      ),
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });

  it("hides SDK error details", async () => {
    const createMessage = vi.fn(async () => {
      throw new Error("Authorization: secret");
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage,
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).rejects.toEqual(
      new FeishuMessageError(
        "send-failed",
        "飞书消息发送失败",
      ),
    );
    expect(createMessage).toHaveBeenCalledOnce();
  });

  it("maps an SDK HTTP timeout to the stable timeout error", async () => {
    const timeout = Object.assign(new Error("request secret"), {
      code: "ECONNABORTED",
    });
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => {
            throw timeout;
          },
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).rejects.toEqual(
      new FeishuMessageError(
        "send-timeout",
        "飞书消息发送超时",
      ),
    );
  });

  it("fails closed when the SDK response has no message ID", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: {} }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
        }),
      },
    );

    await expect(client.sendText("oc_chat", "飞书回复")).rejects.toEqual(
      new FeishuMessageError(
        "invalid-response",
        "飞书消息响应无效",
      ),
    );
  });

  it("downloads an image resource with the exact message and image keys", async () => {
    const stream = Readable.from([Buffer.from("image")]);
    const downloadResource = vi.fn(async () => ({
      getReadableStream: () => stream,
      headers: {
        "content-length": "5",
      },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource,
        }),
      },
    );

    await expect(
      client.downloadImage("om_message", "img_v2_resource"),
    ).resolves.toEqual({
      stream,
      contentLength: 5,
    });
    expect(downloadResource).toHaveBeenCalledWith({
      params: {
        type: "image",
      },
      path: {
        message_id: "om_message",
        file_key: "img_v2_resource",
      },
    });
  });

  it("downloads a file resource with the exact message and file keys", async () => {
    const stream = Readable.from([Buffer.from("file")]);
    const downloadResource = vi.fn(async () => ({
      getReadableStream: () => stream,
      headers: {
        "content-length": "4",
      },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource,
        }),
      },
    );

    await expect(
      client.downloadFile("om_message", "file_v2_resource"),
    ).resolves.toEqual({
      stream,
      contentLength: 4,
    });
    expect(downloadResource).toHaveBeenCalledWith({
      params: {
        type: "file",
      },
      path: {
        message_id: "om_message",
        file_key: "file_v2_resource",
      },
    });
  });

  it("reads visible text from a referenced Feishu message", async () => {
    const getMessage = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{
          msg_type: "post",
          body: {
            content: JSON.stringify({
              zh_cn: {
                title: "标题",
                content: [[
                  { tag: "text", text: "原始" },
                  { tag: "a", text: "链接", href: "https://example.com" },
                ]],
              },
            }),
          },
        }],
      },
    }));
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
          getMessage,
        }),
      },
    );

    await expect(client.readQuotedText("om_parent")).resolves.toBe([
      "标题",
      "原始链接 (https://example.com)",
    ].join("\n"));
    expect(getMessage).toHaveBeenCalledWith({
      params: {
        user_id_type: "open_id",
        card_msg_content_type: "raw_card_content",
      },
      path: { message_id: "om_parent" },
    });
  });

  it("reads visible text from a referenced CardKit message", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
          getMessage: async () => ({
            code: 0,
            data: {
              items: [{
                msg_type: "interactive",
                body: {
                  content: JSON.stringify({
                    card_schema: 2,
                    json_card: JSON.stringify({
                      schema: "2.0",
                      body: {
                        elements: [
                          {
                            tag: "markdown",
                            content: "这是被引用的 **Codex 回复**。",
                          },
                          {
                            tag: "button",
                            text: {
                              tag: "plain_text",
                              content: "不要提取按钮",
                            },
                            value: {
                              interaction_token: "private-token",
                            },
                          },
                        ],
                      },
                    }),
                  }),
                },
              }],
            },
          }),
        }),
      },
    );

    await expect(client.readQuotedText("om_parent")).resolves.toBe(
      "这是被引用的 **Codex 回复**。",
    );
  });

  it("reads normalized Markdown elements from a referenced CardKit message", async () => {
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource: successfulDownload,
          getMessage: async () => ({
            code: 0,
            data: {
              items: [{
                msg_type: "interactive",
                body: {
                  content: JSON.stringify({
                    card_schema: 2,
                    json_card: JSON.stringify({
                      schema: 2,
                      body: {
                        property: {
                          elements: [{
                            tag: "markdown",
                            property: {
                              elements: [
                                {
                                  tag: "text",
                                  property: { content: "规范化的 " },
                                },
                                {
                                  tag: "text",
                                  property: { content: "CardKit 正文" },
                                },
                              ],
                            },
                          }],
                        },
                      },
                    }),
                  }),
                },
              }],
            },
          }),
        }),
      },
    );

    await expect(client.readQuotedText("om_parent")).resolves.toBe(
      "规范化的 CardKit 正文",
    );
  });

  it("rejects unsafe image resource identifiers before calling the SDK", async () => {
    const downloadResource = vi.fn(successfulDownload);
    const client = new FeishuMessageClient(
      {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
      },
      {
        sendTimeoutMs: 1_000,
        createSdkClient: () => ({
          createMessage: async () => ({ data: { message_id: "om_message" } }),
          patchMessage: successfulPatch,
          downloadResource,
        }),
      },
    );

    await expect(
      client.downloadImage("om_message", "../secret"),
    ).rejects.toEqual(new FeishuMessageError(
      "invalid-response",
      "飞书图片资源标识无效",
    ));
    expect(downloadResource).not.toHaveBeenCalled();
  });
});

async function successfulPatch(): Promise<Record<string, never>> {
  return {};
}

async function successfulDownload() {
  return {
    getReadableStream: () => Readable.from([]),
    headers: {},
  };
}

function approvalCard(): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Codex 请求批准",
      },
    },
    elements: [],
  };
}
