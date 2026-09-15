import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuConnectionError,
  FeishuEventConnection,
  type FeishuConnectionState,
} from "../src/surfaces/feishu/event-connection.js";

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

  it("can start a fresh SDK connection after a runtime fatal error", async () => {
    const fixture = createFixture();
    const firstStart = fixture.connection.start();
    fixture.callbacks.onReady();
    await firstStart;
    fixture.callbacks.onError(new Error("offline"));

    const recovery = fixture.connection.start();
    fixture.callbacks.onReady();
    await recovery;

    expect(fixture.connection.state).toBe("running");
    expect(fixture.start).toHaveBeenCalledTimes(2);
    await fixture.connection.stop();
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
