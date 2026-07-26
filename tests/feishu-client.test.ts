import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFeishuHttpPolicy,
  FeishuConnectionError,
  FeishuEventConnection,
  FeishuMessageError,
  FeishuMessageClient,
  type FeishuConnectionState,
} from "../src/surfaces/feishu/client.js";
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
  const start = vi.fn(async () => {});
  const close = vi.fn();
  const onMessage = vi.fn();
  const onInvalidMessage = vi.fn();
  const onCardAction = vi.fn();
  const onInvalidCardAction = vi.fn();
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

  it("returns the message ID for a tracked text message", async () => {
    const createMessage = vi.fn(async () => ({
      data: { message_id: "om_status" },
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
      client.createText("oc_chat", "Thread 状态：运行中"),
    ).resolves.toBe("om_status");
    expect(createMessage).toHaveBeenCalledWith({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: "{\"text\":\"Thread 状态：运行中\"}",
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

  it("updates a text message with the exact message ID and content", async () => {
    const patchMessage = vi.fn(async () => ({ code: 0 }));
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
      client.updateText("om_status", "Thread 状态：空闲"),
    ).resolves.toBeUndefined();

    expect(patchMessage).toHaveBeenCalledOnce();
    expect(patchMessage).toHaveBeenCalledWith({
      path: {
        message_id: "om_status",
      },
      data: {
        content: "{\"text\":\"Thread 状态：空闲\"}",
      },
    });
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
