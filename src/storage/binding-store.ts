import type { ConversationTarget } from "../conversation-core/index.js";

export interface ConversationBinding {
  target: ConversationTarget;
  workspaceId: string;
  threadId: string;
  sessionId: string;
}

export interface BindingStore {
  getWorkspace(target: ConversationTarget): string | undefined;
  selectWorkspace(target: ConversationTarget, workspaceId: string): void;
  get(target: ConversationTarget): ConversationBinding | undefined;
  getByThread(threadId: string): ConversationBinding | undefined;
  list(): ConversationBinding[];
  bind(binding: ConversationBinding): void;
  unbind(target: ConversationTarget): ConversationBinding | undefined;
  close(): void;
}
