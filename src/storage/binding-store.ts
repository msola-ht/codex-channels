import type { ConversationTarget } from "../conversation-core/index.js";

export interface ConversationBinding {
  target: ConversationTarget;
  workspaceId: string;
  threadId: string;
  sessionId: string;
}

export interface BindingTransfer {
  binding: ConversationBinding;
  previousOwner: ConversationBinding;
  replaced?: ConversationBinding;
}

export interface BindingSwitch {
  binding: ConversationBinding;
  backgrounded?: ConversationBinding;
  replaced?: ConversationBinding;
}

export interface BindingStore {
  actors(target: ConversationTarget): string[];
  rememberActor(target: ConversationTarget, actorId: string): void;
  forgetActor(target: ConversationTarget, actorId: string): void;
  /** Atomically removes other Actors and unbinds the Conversation if none remain. */
  retainActors(target: ConversationTarget, actorIds: ReadonlySet<string>): boolean;
  getWorkspace(target: ConversationTarget): string | undefined;
  selectWorkspace(target: ConversationTarget, workspaceId: string): void;
  get(target: ConversationTarget): ConversationBinding | undefined;
  backgrounds(target: ConversationTarget): ConversationBinding[];
  isBackground(threadId: string): boolean;
  getByThread(threadId: string): ConversationBinding | undefined;
  list(): ConversationBinding[];
  bind(binding: ConversationBinding): void;
  bindBackground(binding: ConversationBinding): void;
  switchForeground(binding: ConversationBinding, preserveCurrent: boolean): BindingSwitch;
  demote(target: ConversationTarget): ConversationBinding | undefined;
  removeThread(threadId: string): ConversationBinding | undefined;
  transfer(threadId: string, target: ConversationTarget): BindingTransfer;
  unbind(target: ConversationTarget): ConversationBinding | undefined;
  close(): void;
}
