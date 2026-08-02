import type { ConversationTarget } from "./events.js";

export interface RoutedThread {
  target: ConversationTarget;
  threadId: string;
}

export interface RoutedThreadModelSettings {
  model: string;
  modelProvider?: string;
  effort: string | null;
  serviceTier: string | null;
}

export interface ConversationRoutingPort {
  allBindings(): RoutedThread[];
  foregroundThreadId?(target: ConversationTarget): string | undefined;
  isBackgroundThread?(threadId: string): boolean;
  targetForThread(threadId: string): ConversationTarget | undefined;
  modelSettingsForThread(threadId: string): RoutedThreadModelSettings | undefined;
  contextCompactionItemIdsForThread(threadId: string): readonly string[] | undefined;
}
