import type { ConversationTarget } from "../conversation-core/index.js";
import type {
  NetworkApprovalContext,
  NetworkPolicyAmendment,
} from "./requests.js";

export type InteractionRequest =
  | {
      type: "approval";
      requestId: string;
      kind: "command" | "file" | "permissions";
      threadId: string;
      turnId: string;
      itemId: string;
      title: string;
      detail: string;
      allowSession: boolean;
      execPolicyAmendment?: string[];
      networkApprovalContext?: NetworkApprovalContext;
      networkPolicyAmendments?: NetworkPolicyAmendment[];
      expiresInMs: number;
    }
  | {
      type: "user-input";
      requestId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      title: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: string[];
        allowOther: boolean;
        secret: boolean;
      }>;
      expiresInMs: number;
    }
  | {
      type: "elicitation";
      requestId: string;
      threadId: string;
      turnId: string | null;
      title: string;
      message: string;
      mode: "form" | "tool-approval" | "url";
      url?: string;
      toolApproval?: {
        toolTitle: string | null;
        detail: string;
        allowSession: boolean;
        allowAlways: boolean;
      };
      expiresInMs: number;
    };

export type InteractionDecision =
  | { type: "approval"; approved: true; scope: "once" | "session" | "execpolicy" }
  | {
      type: "approval";
      approved: true;
      scope: "networkpolicy";
      networkPolicyAmendment: NetworkPolicyAmendment;
    }
  | { type: "approval"; approved: false }
  | { type: "user-input"; answers: Record<string, string[]> }
  | {
      type: "elicitation";
      action: "accept" | "decline" | "cancel";
      content: unknown;
      scope?: "once" | "session" | "always";
    };

export interface InteractionPort {
  request(target: ConversationTarget, request: InteractionRequest): Promise<InteractionDecision>;
  resolved?(requestId: string): void;
  cancelAll?(outcome?: string): void;
}

export interface InteractionAuditLogger {
  info(metadata: Record<string, unknown>, message: string): void;
  warn(metadata: Record<string, unknown>, message: string): void;
}
