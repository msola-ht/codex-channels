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
      expiresInMs: number;
    }
  | {
      type: "user-input";
      requestId: string;
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
      title: string;
      message: string;
      mode: "form" | "url";
      url?: string;
      expiresInMs: number;
    };

export type InteractionDecision =
  | { type: "approval"; approved: boolean }
  | { type: "user-input"; answers: Record<string, string[]> }
  | { type: "elicitation"; action: "accept" | "decline" | "cancel"; content: unknown | null };

export interface InteractionPort {
  request(target: ConversationTarget, request: InteractionRequest): Promise<InteractionDecision>;
  resolved?(requestId: string): void;
  cancelAll?(outcome?: string): void;
}
