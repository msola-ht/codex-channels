import type {
  InteractionDecision,
  InteractionRequest,
} from "./types.js";

type ApprovalRequest = Extract<InteractionRequest, { type: "approval" }>;
type ApprovalDecision = Extract<InteractionDecision, { type: "approval" }>;

export type ApprovalChoice =
  | { type: "once" }
  | { type: "session" }
  | { type: "execpolicy" }
  | { type: "networkpolicy"; amendmentIndex: number }
  | { type: "reject" };

export interface ApprovalChoiceResolution {
  decision: ApprovalDecision;
  outcome: string;
}

export function resolveApprovalChoice(
  request: ApprovalRequest,
  choice: ApprovalChoice,
): ApprovalChoiceResolution | undefined {
  switch (choice.type) {
    case "once":
      return {
        decision: {
          type: "approval",
          approved: true,
          scope: "once",
        },
        outcome: "已批准一次",
      };
    case "session":
      return request.allowSession
        ? {
            decision: {
              type: "approval",
              approved: true,
              scope: "session",
            },
            outcome: request.networkApprovalContext
              ? `本会话已允许 ${request.networkApprovalContext.host}`
              : "已在本次会话中始终同意",
          }
        : undefined;
    case "execpolicy":
      return request.execPolicyAmendment
        ? {
            decision: {
              type: "approval",
              approved: true,
              scope: "execpolicy",
            },
            outcome: "已保存命令前缀规则",
          }
        : undefined;
    case "networkpolicy": {
      if (
        !Number.isSafeInteger(choice.amendmentIndex)
        || choice.amendmentIndex < 0
      ) {
        return undefined;
      }
      const amendment = request.networkPolicyAmendments?.[choice.amendmentIndex];
      return amendment
        ? {
            decision: {
              type: "approval",
              approved: true,
              scope: "networkpolicy",
              networkPolicyAmendment: amendment,
            },
            outcome: `已保存网络${amendment.action === "allow" ? "允许" : "拒绝"}规则`,
          }
        : undefined;
    }
    case "reject":
      return {
        decision: {
          type: "approval",
          approved: false,
        },
        outcome: "已拒绝",
      };
  }
}
