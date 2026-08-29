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

export interface RoutedWorkspace {
  id: string;
  name: string;
}

export interface ConversationRoutingPort {
  allBindings(): RoutedThread[];
  foregroundThreadId?(target: ConversationTarget): string | undefined;
  isBackgroundThread?(threadId: string): boolean;
  targetForThread(threadId: string): ConversationTarget | undefined;
  workspaceForThread?(threadId: string): RoutedWorkspace | undefined;
  modelSettingsForThread(threadId: string): RoutedThreadModelSettings | undefined;
  threadNameForThread?(threadId: string): string | null | undefined;
  contextCompactionItemIdsForThread(threadId: string): readonly string[] | undefined;
}
