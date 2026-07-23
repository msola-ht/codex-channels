import type { ConversationTarget } from "./events.js";

export interface RoutedThread {
  target: ConversationTarget;
  threadId: string;
}

export interface RoutedThreadModelSettings {
  model: string;
  effort: string | null;
}

export interface ConversationRoutingPort {
  allBindings(): RoutedThread[];
  targetForThread(threadId: string): ConversationTarget | undefined;
  modelSettingsForThread(threadId: string): RoutedThreadModelSettings | undefined;
}
