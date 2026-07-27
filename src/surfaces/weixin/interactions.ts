import {
  safeInteractionDecision,
  type InteractionDecision,
  type InteractionPort,
  type InteractionRequest,
} from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";

export class WeixinInteractionPort implements InteractionPort {
  request(
    _target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    return Promise.resolve(safeInteractionDecision(request));
  }

  resolved(requestId: string): void {
    void requestId;
  }

  cancelAll(outcome?: string): void {
    void outcome;
  }
}
