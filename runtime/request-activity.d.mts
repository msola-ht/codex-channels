export interface RequestActivity { toolResult: boolean; reply: boolean; toolCalls: boolean; tools: string[]; partial: boolean }
export function validRequestActivity(value: unknown): value is RequestActivity;
export class RequestActivityObserver {
  request(body: unknown, protocol?: "chat" | "responses"): void;
  response(value: unknown, protocol?: "chat" | "responses"): void;
  incomplete(): void;
  finishChatChoice(index: number): void;
  snapshot(): RequestActivity | null;
}
