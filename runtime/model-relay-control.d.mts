export class ModelRelayControl {
  constructor(path: string, handler: (request: { operation: "apply" | "status" | "queue"; digest?: string }, signal: AbortSignal) => Promise<Record<string, unknown>>);
  start(): Promise<void>;
  changed(): void;
  close(): Promise<void>;
}
export function queryModelRelayControl(path: string, operation: "apply" | "status" | "queue", digest?: string): Promise<Record<string, unknown>>;

export function watchRelayChanges(path: string, signal: AbortSignal, receive: (type: "changed" | "heartbeat") => void): Promise<void>;
