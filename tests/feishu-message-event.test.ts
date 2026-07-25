import { describe, expect, it } from "vitest";

import {
  FeishuMessageEventError,
  decodeFeishuMessageEvent,
  type FeishuMessageEventField,
} from "../src/surfaces/feishu/message-event.js";

function createEvent(): Record<string, unknown> {
  return {
    event_id: "event-1",
    app_id: "cli_0123456789abcdef",
    sender: {
      sender_id: {
        open_id: "ou_actor",
        user_id: "user-id-is-not-used",
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
      root_id: "ignored",
    },
  };
}

describe("decodeFeishuMessageEvent", () => {
  it("maps only the stable fields needed by the platform boundary", () => {
    expect(decodeFeishuMessageEvent(createEvent())).toEqual({
      eventId: "event-1",
      appId: "cli_0123456789abcdef",
      actorOpenId: "ou_actor",
      senderType: "user",
      messageId: "om_message",
      createTime: "1784900000000",
      chatId: "oc_chat",
      chatType: "p2p",
      messageType: "text",
      content: "{\"text\":\"hello\"}",
    });
  });

  it("allows optional envelope identifiers to be absent", () => {
    const event = createEvent();
    delete event.event_id;
    delete event.app_id;

    const decoded = decodeFeishuMessageEvent(event);

    expect(decoded.eventId).toBeUndefined();
    expect(decoded.appId).toBeUndefined();
  });

  it.each<[unknown, FeishuMessageEventField]>([
    [null, "event"],
    [{}, "sender"],
    [{ ...createEvent(), sender: {} }, "sender.sender_id"],
    [
      {
        ...createEvent(),
        sender: {
          sender_id: {},
          sender_type: "user",
        },
      },
      "sender.sender_id.open_id",
    ],
    [
      {
        ...createEvent(),
        message: {
          message_id: "om_message",
        },
      },
      "message.create_time",
    ],
  ])("rejects malformed input without retaining its value", (input, field) => {
    let thrown: unknown;
    try {
      decodeFeishuMessageEvent(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new FeishuMessageEventError(field));
    expect(thrown).not.toHaveProperty("input");
    expect(thrown).not.toHaveProperty("value");
  });
});
