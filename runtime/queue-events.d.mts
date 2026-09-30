export class QueueEventsServer {
  constructor(path: string);
  start(): Promise<void>;
  changed(): void;
  close(): Promise<void>;
}
export function watchQueueChanges(path: string, signal: AbortSignal, receive: (type: "changed" | "heartbeat") => void): Promise<void>;
