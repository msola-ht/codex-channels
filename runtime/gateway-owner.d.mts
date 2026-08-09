export class GatewayOwnershipError extends Error {}

export class GatewayOwner {
  constructor(configPath: string);
  start(): Promise<void>;
  close(): Promise<void>;
}

export function gatewayOwnerSocketPath(configPath: string): string;
