import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";

export class FeishuInteractionPort implements InteractionPort {
  request(
    _target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    switch (request.type) {
      case "approval":
        return Promise.resolve({ type: "approval", approved: false });
      case "user-input":
        return Promise.resolve({ type: "user-input", answers: {} });
      case "elicitation":
        return Promise.resolve({
          type: "elicitation",
          action: "cancel",
          content: null,
        });
    }
  }

  resolved(requestId: string): void {
    void requestId;
  }

  cancelAll(outcome?: string): void {
    void outcome;
  }
}
