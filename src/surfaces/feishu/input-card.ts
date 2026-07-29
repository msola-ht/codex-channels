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
  if (request.type === "elicitation" && request.mode === "url") {
    return legacyCard(
      "Codex 交互已处理",
      request.title,
      [note(`处理结果：${outcome}`)],
      accepted(decision) ? "green" : "grey",
    );
  }
  const elements = [
    markdown(`**处理结果：** ${escapeMarkdown(outcome)}`),
  ];
  if (
    request.type === "user-input"
    && decision.type === "user-input"
    && Object.keys(decision.answers).length > 0
  ) {
    for (const question of request.questions) {
      const answer = question.secret
        ? "已提交（敏感内容不显示）"
        : decision.answers[question.id]?.join("、");
      if (answer) {
        elements.push(markdown(
          `**${escapeMarkdown(question.header)}：** ${escapeMarkdown(answer)}`,
        ));
      }
    }
  }
  return cardKit(
    "Codex 交互已处理",
    elements,
    accepted(decision) ? "green" : "grey",
  );
}

function renderUserInputCard(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  interactionToken: string,
): FeishuCardDocument {
  const formElements: Array<Record<string, unknown>> = [];
  request.questions.forEach((question, index) => {
    if (index > 0) {
      formElements.push({ tag: "hr" });
    }
    formElements.push(markdown(
      `**${escapeMarkdown(truncate(
        question.header || `问题 ${index + 1}`,
        maximumLabelLength,
      ))}**\n${escapeMarkdown(truncate(question.question, maximumDisplayLength))}`,
    ));
    if (question.options.length > 0) {
      formElements.push({
        tag: "select_static",
        name: `q${index}_choice`,
        required: !question.allowOther,
        placeholder: {
          tag: "plain_text",
          content: "请选择",
        },
        options: question.options.map((option) => ({
          text: {
            tag: "plain_text",
            content: truncate(option, maximumLabelLength),
          },
          value: option,
        })),
      });
      if (question.allowOther) {
        formElements.push(input(
          `q${index}_other`,
          "其他内容（可选）",
          "如不采用上方选项，请在这里输入",
          false,
          false,
        ));
      }
      return;
    }
    formElements.push(input(
      `q${index}_text`,
      question.secret ? "敏感回答" : "回答",
      question.secret ? "请输入敏感内容" : "请输入回答",
      true,
      question.secret,
    ));
  });
  formElements.push({ tag: "hr" });
  formElements.push(formSubmitButton("提交回答", interactionToken));

  return cardKit(
    "Codex 需要补充信息",
    [
      {
        tag: "form",
        name: "codexc_user_input",
        elements: formElements,
      },
      actionButton("取消", "danger", interactionToken, "cancel"),
    ],
  );
}

function renderFormElicitationCard(
  request: Extract<InteractionRequest, { type: "elicitation" }>,
  interactionToken: string,
): FeishuCardDocument {
  return cardKit(
    "MCP 请求输入",
    [
      markdown(escapeMarkdown(truncate(request.message, maximumDisplayLength))),
      markdown("请填写有效 JSON。提交内容不会写入 Gateway 数据库或日志。"),
      {
        tag: "form",
        name: "codexc_mcp_form",
        elements: [
          input("content", "JSON 内容", "{\"key\":\"value\"}", true, false, 4, 8),
          formSubmitButton("提交表单", interactionToken),
        ],
      },
      actionButton("取消", "danger", interactionToken, "cancel"),
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
  return legacyCard(
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

function legacyCard(
  header: string,
  title: string,
  elements: Array<Record<string, unknown>>,
  template: "blue" | "green" | "grey" = "blue",
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template,
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

function cardKit(
  header: string,
  elements: Array<Record<string, unknown>>,
  template: "blue" | "green" | "grey" = "blue",
): FeishuCardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: header,
      },
    },
    body: {
      elements,
    },
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
    name: `codexc_submit_${interactionToken}`,
    form_action_type: "submit",
    value: {
      interaction_token: interactionToken,
      decision: "submit",
    },
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

function input(
  name: string,
  label: string,
  placeholder: string,
  required: boolean,
  secret: boolean,
  rows = 2,
  maximumRows = 5,
): Record<string, unknown> {
  return {
    tag: "input",
    name,
    required,
    input_type: secret ? "password" : "multiline_text",
    ...(secret
      ? { show_icon: false }
      : { rows, auto_resize: true, max_rows: maximumRows }),
    max_length: maximumInputLength,
    width: "fill",
    label: {
      tag: "plain_text",
      content: label,
    },
    label_position: "top",
    placeholder: {
      tag: "plain_text",
      content: placeholder,
    },
  };
}

function markdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(/([`*_~[\]()>#+\-.!|])/gu, "\\$1");
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
