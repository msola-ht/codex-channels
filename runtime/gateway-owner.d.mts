export class GatewayOwnershipError extends Error {}

export class GatewayOwner {
  constructor(configPath: string);
  start(): Promise<void>;
  markReady(): void;
  markNotReady(): void;
  close(): Promise<void>;
}

export function gatewayOwnerSocketPath(configPath: string): string;
/** False only for an absent/refused endpoint; unknown activity rejects maintenance. */
export function gatewayOwnerIsActive(configPath: string, signal?: AbortSignal): Promise<boolean>;
export function gatewayOwnerIsReady(configPath: string, signal?: AbortSignal): Promise<boolean>;
