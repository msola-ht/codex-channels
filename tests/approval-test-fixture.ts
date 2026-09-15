import type {
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "../src/approval/types.js";
import type { ConversationTarget } from "../src/conversation-core/events.js";

export const approvalTarget: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

export class FakeInteraction implements InteractionPort {
  requests: InteractionRequest[] = [];
  resolvedIds: string[] = [];
  cancelledOutcomes: Array<string | undefined> = [];

  constructor(
    private readonly decision: InteractionDecision = {
      type: "approval",
      approved: true,
      scope: "once",
    },
  ) {}

  async request(
    _target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    this.requests.push(request);
    return this.decision;
  }

  resolved(requestId: string): void {
    this.resolvedIds.push(requestId);
  }

  cancelAll(outcome?: string): void {
    this.cancelledOutcomes.push(outcome);
  }
}
