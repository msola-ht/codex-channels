import type { ConversationTarget } from "../conversation-core/index.js";

export interface SurfaceAccessContext {
  target: ConversationTarget;
  actorId: string;
}

export interface SurfaceAccessPolicy {
  isAllowed(context: SurfaceAccessContext): boolean;
}
