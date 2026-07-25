import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuConnectionError,
  FeishuEventConnection,
  FeishuMessageError,
  FeishuMessageClient,
  type FeishuConnectionState,
} from "../src/surfaces/feishu/client.js";

interface FakeCallbacks {
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

function createFixture(startupTimeoutMs = 1_000) {
  let callbacks: FakeCallbacks | undefined;
  let messageHandler: ((event: unknown) => void) | undefined;
  const start = vi.fn(async () => {});
  const close = vi.fn();
  const onMessage = vi.fn();
  const onInvalidMessage = vi.fn();
  const onReconnecting = vi.fn();
  const onReconnected = vi.fn();
  const onFatal = vi.fn();
  const connection = new FeishuEventConnection(
    {
      appId: "cli_0123456789abcdef",
      appSecret: "secret",
      onMessage,
      onInvalidMessage,
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
  };
}

afterEach(() => {
  vi.useRealTimers();
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
        createSdkClient: () => ({ createMessage }),
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
        createSdkClient: () => ({ createMessage }),
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
        createSdkClient: () => ({ createMessage }),
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
        createSdkClient: () => ({ createMessage }),
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
});
