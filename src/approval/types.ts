import type { ConversationTarget } from "../conversation-core/index.js";

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
      mode: "form" | "url";
      url?: string;
      expiresInMs: number;
    };

export type InteractionDecision =
  | { type: "approval"; approved: true; scope: "once" | "session" }
  | { type: "approval"; approved: false }
  | { type: "user-input"; answers: Record<string, string[]> }
  | { type: "elicitation"; action: "accept" | "decline" | "cancel"; content: unknown };

export interface InteractionPort {
  request(target: ConversationTarget, request: InteractionRequest): Promise<InteractionDecision>;
  resolved?(requestId: string): void;
  cancelAll?(outcome?: string): void;
}
