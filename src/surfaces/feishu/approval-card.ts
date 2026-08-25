import type {
  InteractionDecision,
  InteractionRequest,
} from "../../approval/index.js";
import { interactionProcessedTitle } from "../interaction-copy.js";
import { contentTruncatedText } from "../output-copy.js";

export interface FeishuCardKitDocument {
  schema: "2.0";
  config: {
    update_multi: true;
    wide_screen_mode: true;
  };
  header: {
    template: "blue" | "green" | "grey";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
}

export type FeishuCardDocument = FeishuCardKitDocument;

export function feishuCardElements(
  card: FeishuCardDocument,
): readonly Record<string, unknown>[] {
  return card.body.elements;
}

export type FeishuApprovalAction =
  | "approve-once"
  | "approve-session"
  | "approve-execpolicy"
  | `approve-network-${number}`
  | "reject";

const maximumDetailBytes = 12_000;
const maximumPreviewCharacters = 150;
const maximumPreviewLines = 3;
const truncatedSuffix = `\n\n[${contentTruncatedText}]`;

export function renderFeishuApprovalCard(
  request: Extract<InteractionRequest, { type: "approval" }>,
  interactionToken: string,
): FeishuCardDocument {
  const actions: Array<Record<string, unknown>> = [
    button("批准一次", "primary", interactionToken, "approve-once"),
  ];
  if (request.execPolicyAmendment) {
    actions.push(
      button(
        "始终允许此前缀",
        "default",
        interactionToken,
        "approve-execpolicy",
      ),
    );
  }
  for (const [index, amendment] of (
    request.networkPolicyAmendments ?? []
  ).entries()) {
    actions.push(
      button(
        `始终${amendment.action === "allow" ? "允许" : "拒绝"} ${amendment.host}`,
        "default",
        interactionToken,
        `approve-network-${index}`,
      ),
    );
  }
  if (request.allowSession) {
    actions.push(
      button(
        request.networkApprovalContext
          ? `本会话允许 ${request.networkApprovalContext.host}`
          : "本次会话始终同意",
        "default",
        interactionToken,
        "approve-session",
      ),
    );
  }
  actions.push(button("拒绝", "danger", interactionToken, "reject"));

  return cardKit("Codex 请求批准", "blue", [
    markdown(request.title),
    ...approvalDetailElements(request.detail),
    ...actionRows(actions),
  ]);
}

export function renderFeishuApprovalOutcomeCard(
  request: Extract<InteractionRequest, { type: "approval" }>,
  decision: Extract<InteractionDecision, { type: "approval" }>,
  outcome: string,
): FeishuCardDocument {
  return cardKit(interactionProcessedTitle, decision.approved ? "green" : "grey", [
    markdown(request.title),
    ...approvalDetailElements(request.detail),
    markdown(`处理结果：${outcome}`),
  ]);
}

function cardKit(
  title: string,
  template: "blue" | "green" | "grey",
  elements: Array<Record<string, unknown>>,
): FeishuCardKitDocument {
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
        content: title,
      },
    },
    body: { elements },
  };
}

function markdown(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function approvalDetailElements(detail: string): Array<Record<string, unknown>> {
  const preview = approvalDetailPreview(detail);
  if (!preview.truncated) {
    return [plainText(detail)];
  }
  return [
    plainText(`审批内容预览：\n${preview.text}`),
    collapsedDetail(detail),
  ];
}

function approvalDetailPreview(detail: string): {
  text: string;
  truncated: boolean;
} {
  const lines = detail.split(/\r?\n/u);
  const visibleLines = lines.slice(0, maximumPreviewLines).join("\n");
  const characters = Array.from(visibleLines);
  const truncated = lines.length > maximumPreviewLines
    || characters.length > maximumPreviewCharacters;
  if (!truncated) {
    return { text: detail, truncated: false };
  }
  return {
    text: `${characters.slice(0, maximumPreviewCharacters).join("").trimEnd()}…`,
    truncated: true,
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

function collapsedDetail(detail: string): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: "完整审批内容",
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: truncateUtf8(detail, maximumDetailBytes),
        },
      },
    ],
  };
}

function actionRows(
  actions: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < actions.length; index += 3) {
    rows.push({
      tag: "column_set",
      flex_mode: "stretch",
      horizontal_spacing: "8px",
      columns: actions.slice(index, index + 3).map((action) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [action],
      })),
    });
  }
  return rows;
}

function button(
  text: string,
  type: "primary" | "default" | "danger",
  interactionToken: string,
  decision: FeishuApprovalAction,
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

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  const payloadLimit = maximumBytes - Buffer.byteLength(
    truncatedSuffix,
    "utf8",
  );
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > payloadLimit) {
      break;
    }
    result += character;
  }
  return `${result}${truncatedSuffix}`;
}
