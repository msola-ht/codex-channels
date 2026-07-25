import type {
  InteractionDecision,
  InteractionRequest,
} from "../../approval/index.js";

export interface FeishuCardDocument {
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
  elements: Array<Record<string, unknown>>;
}

export type FeishuApprovalAction =
  | "approve-once"
  | "approve-session"
  | "approve-execpolicy"
  | `approve-network-${number}`
  | "reject";

const maximumDetailBytes = 12_000;
const truncatedSuffix = "\n\n[内容过长，已截断]";

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
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: request.title,
        },
      },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: truncateUtf8(request.detail, maximumDetailBytes),
        },
      },
      {
        tag: "action",
        actions,
      },
    ],
  };
}

export function renderFeishuApprovalOutcomeCard(
  request: Extract<InteractionRequest, { type: "approval" }>,
  decision: Extract<InteractionDecision, { type: "approval" }>,
  outcome: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: decision.approved ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: "Codex 审批已处理",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: request.title,
        },
      },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: truncateUtf8(request.detail, maximumDetailBytes),
        },
      },
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
