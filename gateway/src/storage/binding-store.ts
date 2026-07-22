import type { ConversationTarget } from "../conversation-core/events.js";

export interface ConversationBinding {
  target: ConversationTarget;
  threadId: string;
  sessionId: string;
}

export interface BindingStore {
  get(target: ConversationTarget): ConversationBinding | undefined;
  getByThread(threadId: string): ConversationBinding | undefined;
  list(): ConversationBinding[];
  bind(binding: ConversationBinding): void;
  unbind(target: ConversationTarget): ConversationBinding | undefined;
  close(): void;
}
