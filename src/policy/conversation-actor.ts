import type { ConversationTarget } from "../conversation-core/index.js";

export interface ConversationActorRegistry {
  actors(target: ConversationTarget): string[];
  rememberActor(target: ConversationTarget, actorId: string): void;
}
