export type GatewayAccountRefreshErrorCode =
  | "gateway_unavailable"
  | "invalid_request"
  | "invalid_response"
  | "provider_not_found"
  | "refresh_failed";

export type AccountRefreshReason = "configuration" | "timeout" | "authentication" | "rate-limited" | "upstream" | "network" | "invalid-response" | "internal";

export class GatewayAccountRefreshError extends Error {
  readonly code: GatewayAccountRefreshErrorCode;
  readonly reason?: AccountRefreshReason;
  constructor(
    code: GatewayAccountRefreshErrorCode,
    message: string,
    options?: ErrorOptions & { reason?: AccountRefreshReason },
  );
}

export class GatewayAccountRefreshServer {
  constructor(
    configPath: string,
    refreshAccount: (provider: string, signal: AbortSignal) => boolean | Promise<boolean>,
  );
  start(): Promise<void>;
  close(): Promise<void>;
}

export function gatewayAccountRefreshSocketPath(configPath: string): string;
export function requestGatewayAccountRefresh(
  configPath: string,
  provider: string,
  signal?: AbortSignal,
): Promise<{ provider: string }>;
