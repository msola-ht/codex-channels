import type {
  InteractionDecision,
  InteractionRequest,
} from "../../approval/index.js";
import type { FeishuCardDocument } from "./approval-card.js";

export type FeishuInputAction = "submit" | "complete" | "cancel";

const maximumQuestionCount = 3;
const maximumInputLength = 1_000;
const maximumLabelLength = 100;
const maximumDisplayLength = 1_000;
const truncatedSuffix = "…";

export function supportsFeishuInputRequest(
  request: Exclude<InteractionRequest, { type: "approval" }>,
): boolean {
  if (request.type === "user-input") {
    return request.questions.length > 0
      && request.questions.length <= maximumQuestionCount;
  }
  return request.mode === "form"
    || (request.url !== undefined && safeHttpUrl(request.url) !== undefined);
}

export function renderFeishuInputCard(
  request: Exclude<InteractionRequest, { type: "approval" }>,
  interactionToken: string,
): FeishuCardDocument {
  if (request.type === "user-input") {
    return renderUserInputCard(request, interactionToken);
  }
  return request.mode === "url"
    ? renderUrlElicitationCard(request, interactionToken)
    : renderFormElicitationCard(request, interactionToken);
}

export function renderFeishuInputOutcomeCard(
  request: Exclude<InteractionRequest, { type: "approval" }>,
  decision: Exclude<InteractionDecision, { type: "approval" }>,
  outcome: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: accepted(decision) ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: "Codex 交互已处理",
      },
    },
    elements: [
      plainText(request.title),
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: `处理结果：${outcome}`,
        }],
      },
    ],
  };
}

function renderUserInputCard(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  interactionToken: string,
): FeishuCardDocument {
  const formElements: Array<Record<string, unknown>> = [];
  request.questions.forEach((question, index) => {
    const optionText = question.options.length > 0
      ? `可选：${question.options.join(" / ")}${
        question.allowOther ? "；也可输入其他内容" : ""
      }`
      : undefined;
    formElements.push(
      plainText(truncate(question.question, maximumDisplayLength)),
    );
    if (optionText) {
      formElements.push(note(truncate(optionText, maximumDisplayLength)));
    }
    formElements.push({
      tag: "input",
      name: `q${index}`,
      required: true,
      input_type: question.secret ? "password" : "multiline_text",
      ...(question.secret
        ? { show_icon: false }
        : { rows: 2, auto_resize: true, max_rows: 5 }),
      max_length: maximumInputLength,
      width: "fill",
      label: {
        tag: "plain_text",
        content: truncate(
          question.header || `问题 ${index + 1}`,
          maximumLabelLength,
        ),
      },
      label_position: "top",
      placeholder: {
        tag: "plain_text",
        content: question.secret ? "请输入敏感内容" : "请输入回答",
      },
      fallback: {
        tag: "fallback_text",
        text: {
          tag: "plain_text",
          content: "请升级飞书客户端后填写此请求",
        },
      },
    });
  });
  formElements.push(
    formSubmitButton("提交回答", interactionToken),
  );

  return card(
    "Codex 需要补充信息",
    request.title,
    [
      {
        tag: "form",
        name: "codexc_user_input",
        elements: formElements,
        fallback: {
          tag: "fallback_text",
          text: {
            tag: "plain_text",
            content: "请升级飞书客户端后填写此请求",
          },
        },
      },
      cancelAction(interactionToken),
    ],
  );
}

function renderFormElicitationCard(
  request: Extract<InteractionRequest, { type: "elicitation" }>,
  interactionToken: string,
): FeishuCardDocument {
  return card(
    "MCP 请求输入",
    request.title,
    [
      plainText(truncate(request.message, maximumDisplayLength)),
      note("请填写有效 JSON。提交内容不会写入 Gateway 数据库或日志。"),
      {
        tag: "form",
        name: "codexc_mcp_form",
        elements: [
          {
            tag: "input",
            name: "content",
            required: true,
            input_type: "multiline_text",
            rows: 4,
            auto_resize: true,
            max_rows: 8,
            max_length: maximumInputLength,
            width: "fill",
            label: {
              tag: "plain_text",
              content: "JSON 内容",
            },
            label_position: "top",
            placeholder: {
              tag: "plain_text",
              content: "{\"key\":\"value\"}",
            },
            fallback: {
              tag: "fallback_text",
              text: {
                tag: "plain_text",
                content: "请升级飞书客户端后填写此请求",
              },
            },
          },
          formSubmitButton("提交表单", interactionToken),
        ],
        fallback: {
          tag: "fallback_text",
          text: {
            tag: "plain_text",
            content: "请升级飞书客户端后填写此请求",
          },
        },
      },
      cancelAction(interactionToken),
    ],
  );
}

function renderUrlElicitationCard(
  request: Extract<InteractionRequest, { type: "elicitation" }>,
  interactionToken: string,
): FeishuCardDocument {
  const url = safeHttpUrl(request.url);
  if (!url) {
    throw new Error("飞书 MCP URL 无效");
  }
  return card(
    "MCP 请求确认",
    request.title,
    [
      plainText(truncate(request.message, maximumDisplayLength)),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: {
              tag: "plain_text",
              content: "打开链接",
            },
            url,
          },
          actionButton("完成", "default", interactionToken, "complete"),
          actionButton("取消", "danger", interactionToken, "cancel"),
        ],
      },
    ],
  );
}

function card(
  header: string,
  title: string,
  elements: Array<Record<string, unknown>>,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: header,
      },
    },
    elements: [
      plainText(truncate(title, maximumDisplayLength)),
      ...elements,
    ],
  };
}

function plainText(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
    },
  };
}

function note(content: string): Record<string, unknown> {
  return {
    tag: "note",
    elements: [{
      tag: "plain_text",
      content,
    }],
  };
}

function formSubmitButton(
  text: string,
  interactionToken: string,
): Record<string, unknown> {
  return {
    tag: "button",
    type: "primary",
    text: {
      tag: "plain_text",
      content: text,
    },
    name: "codexc_submit",
    complex_interaction: true,
    action_type: "form_submit",
    value: {
      interaction_token: interactionToken,
      decision: "submit",
    },
  };
}

function cancelAction(interactionToken: string): Record<string, unknown> {
  return {
    tag: "action",
    actions: [
      actionButton("取消", "danger", interactionToken, "cancel"),
    ],
  };
}

function actionButton(
  text: string,
  type: "default" | "danger",
  interactionToken: string,
  decision: FeishuInputAction,
): Record<string, unknown> {
  return {
    tag: "button",
    type,
    text: {
      tag: "plain_text",
      content: text,
    },
    value: {
      interaction_token: interactionToken,
      decision,
    },
  };
}

function accepted(
  decision: Exclude<InteractionDecision, { type: "approval" }>,
): boolean {
  return decision.type === "user-input"
    ? Object.keys(decision.answers).length > 0
    : decision.action === "accept";
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, maximumLength - truncatedSuffix.length)}${truncatedSuffix}`;
}
