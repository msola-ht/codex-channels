export class GatewayOwnershipError extends Error {}

export class GatewayOwner {
  constructor(configPath: string);
  start(): Promise<void>;
  markReady(): void;
  markNotReady(): void;
  close(): Promise<void>;
}

export function gatewayOwnerSocketPath(configPath: string): string;
export function gatewayOwnerIsActive(configPath: string): Promise<boolean>;
export function gatewayOwnerIsReady(configPath: string): Promise<boolean>;
