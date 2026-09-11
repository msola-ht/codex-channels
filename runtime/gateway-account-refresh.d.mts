export type GatewayAccountRefreshErrorCode =
  | "gateway_unavailable"
  | "invalid_request"
  | "invalid_response"
  | "provider_not_found"
  | "refresh_failed";

export class GatewayAccountRefreshError extends Error {
  readonly code: GatewayAccountRefreshErrorCode;
  constructor(code: GatewayAccountRefreshErrorCode, message: string, options?: ErrorOptions);
}

export class GatewayAccountRefreshServer {
  constructor(
    configPath: string,
    refreshAccount: (provider: string) => boolean | Promise<boolean>,
  );
  start(): Promise<void>;
  close(): Promise<void>;
}

export function gatewayAccountRefreshSocketPath(configPath: string): string;
export function requestGatewayAccountRefresh(
  configPath: string,
  provider: string,
): Promise<{ provider: string }>;
