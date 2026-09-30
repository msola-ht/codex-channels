export type DeliveryResolutionEntry = { id: string; revision: string };
export class DeliveryControlServer {
  constructor(directory: string, resolve: (entries: DeliveryResolutionEntry[], action: "retry" | "ignore") => Promise<boolean>);
  start(): Promise<void>;
  changed(): void;
  close(): Promise<void>;
}
export function requestDeliveryResolution(directory: string, entries: DeliveryResolutionEntry[], action: "retry" | "ignore"): Promise<"applied" | "stale" | "busy" | "unconfirmed" | null>;

export function deliveryControlSocketPath(directory: string): string;
export function watchDeliveryChanges(directory: string, signal: AbortSignal, receive: (type: "changed" | "heartbeat") => void): Promise<void>;
