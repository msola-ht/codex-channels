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

  it("normalizes a CardKit form submit from its bounded button name", () => {
    const input = createAction();
    input.action = {
      tag: "form_submit",
      name: "codexc_submit_opaque-token",
      form_name: "codexc_user_input",
      form_value: {
        q0_choice: "测试环境",
        q0_other: "",
      },
    };

    expect(decodeFeishuCardAction(input)).toEqual({
      messageId: "om_message",
      chatId: "oc_chat",
      actorOpenId: "ou_actor",
      tag: "form_submit",
      value: {
        interaction_token: "opaque-token",
        decision: "submit",
      },
      formValues: {
        q0_choice: "测试环境",
        q0_other: "",
      },
    });
  });

  it("normalizes a command center form submit from its bounded button name", () => {
    const input = createAction();
    input.action = {
      tag: "form_submit",
      name: "codexc_command_submit_opaque-token",
      form_name: "codexc_command_form",
      form_value: {
        input: "完成飞书接入",
      },
    };

    expect(decodeFeishuCardAction(input)).toEqual({
      messageId: "om_message",
      chatId: "oc_chat",
      actorOpenId: "ou_actor",
      tag: "form_submit",
      value: {
        codexc_command_token: "opaque-token",
      },
      formValues: {
        input: "完成飞书接入",
      },
    });
  });

  it("normalizes a command form submit delivered with button tag", () => {
    const input = createAction();
    input.action = {
      tag: "button",
      name: "codexc_command_submit_opaque-token",
      form_name: "codexc_command_form",
      form_value: {
        input: "main",
      },
    };

    expect(decodeFeishuCardAction(input).value).toEqual({
      codexc_command_token: "opaque-token",
    });
  });

  it("keeps bounded form values for up to three user-input questions", () => {
    const input = createAction();
    input.action = {
      tag: "form_submit",
      name: "codexc_submit_opaque-token",
      form_name: "codexc_user_input",
      form_value: {
        q0_choice: "选项一",
        q0_other: "",
        q1_choice: "选项二",
        q1_other: "自定义",
        q2_choice: "选项三",
        q2_other: "",
      },
    };

    expect(decodeFeishuCardAction(input).formValues).toEqual({
      q0_choice: "选项一",
      q0_other: "",
      q1_choice: "选项二",
      q1_other: "自定义",
      q2_choice: "选项三",
      q2_other: "",
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
    [{
      ...createAction(),
      action: {
        tag: "form_submit",
        name: "codexc_command_submit_",
        form_name: "codexc_command_form",
        form_value: { input: "x" },
      },
    }, "action.value"],
    [{
      ...createAction(),
      action: {
        tag: "form_submit",
        name: "codexc_command_submit_opaque-token",
        form_name: "codexc_user_input",
        form_value: { input: "x" },
      },
    }, "action.value"],
    [{
      ...createAction(),
      action: {
        tag: "form_submit",
        name: "codexc_submit_opaque-token",
        form_name: "codexc_command_form",
        form_value: { input: "x" },
      },
    }, "action.value"],
    [{
      ...createAction(),
      action: {
        tag: "form_submit",
        name: "codexc_submit_opaque-token",
        form_name: "codexc_user_input",
        form_value: {
          q0: "1",
          q1: "2",
          q2: "3",
          q3: "4",
          q4: "5",
          q5: "6",
          q6: "7",
        },
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
