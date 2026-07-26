import { describe, expect, it } from "vitest";

import {
  decodeFeishuCardAction,
  FeishuCardActionError,
  type FeishuCardActionField,
} from "../src/surfaces/feishu/card-action.js";

function createAction(): Record<string, unknown> {
  return {
    context: {
      open_message_id: "om_message",
      open_chat_id: "oc_chat",
    },
    operator: {
      open_id: "ou_actor",
      user_id: "ignored",
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
      timezone: "Asia/Shanghai",
    },
    token: "platform-token-is-not-retained",
  };
}

describe("decodeFeishuCardAction", () => {
  it("maps only the stable routing and string action fields", () => {
    expect(decodeFeishuCardAction(createAction())).toEqual({
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
  });

  it.each<[unknown, FeishuCardActionField]>([
    [null, "event"],
    [{}, "context"],
    [{
      ...createAction(),
      context: { open_chat_id: "oc_chat" },
    }, "context.open_message_id"],
    [{
      ...createAction(),
      operator: {},
    }, "operator.open_id"],
    [{
      ...createAction(),
      action: { tag: "button", value: { nested: {} } },
    }, "action.value"],
    [{
      ...createAction(),
      action: {
        tag: "button",
        value: { interaction_token: "token", decision: "submit" },
        form_value: { q0: { nested: true } },
      },
    }, "action.form_value"],
    [{
      ...createAction(),
      action: {
        tag: "button",
        value: { interaction_token: "token", decision: "submit" },
        form_value: { q0: "x".repeat(1_001) },
      },
    }, "action.form_value"],
  ])("rejects malformed input without retaining it", (input, field) => {
    let thrown: unknown;
    try {
      decodeFeishuCardAction(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new FeishuCardActionError(field));
    expect(thrown).not.toHaveProperty("input");
    expect(thrown).not.toHaveProperty("value");
  });
});
