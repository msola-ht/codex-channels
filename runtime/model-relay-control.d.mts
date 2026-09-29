export class ModelRelayControl {
  constructor(path: string, handler: (request: { operation: "apply" | "status"; digest?: string }, signal: AbortSignal) => Promise<Record<string, unknown>>);
  start(): Promise<void>;
  close(): Promise<void>;
}
export function queryModelRelayControl(path: string, operation: "apply" | "status", digest?: string): Promise<Record<string, unknown>>;
