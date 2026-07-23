import type { ConversationTarget } from "../conversation-core/index.js";

export interface ConversationActorRegistry {
  rememberActor(target: ConversationTarget, actorId: string): void;
}
