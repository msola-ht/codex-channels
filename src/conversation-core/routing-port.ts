import type { ConversationTarget } from "./events.js";

export interface RoutedThread {
  target: ConversationTarget;
  threadId: string;
}

export interface ConversationRoutingPort {
  allBindings(): RoutedThread[];
  targetForThread(threadId: string): ConversationTarget | undefined;
}
