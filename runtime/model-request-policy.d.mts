export const modelRequestPolicy: Readonly<{
  preparationTimeoutMs: number;
  headersTimeoutMs: number;
  streamIdleTimeoutMs: number;
  websocketConnectTimeoutMs: number;
  bodyReadTimeoutMs: number;
  errorBodyTimeoutMs: number;
  deliveryTimeoutMs: number;
  terminalDeliveryTimeoutMs: number;
  metricsDeliveryTimeoutMs: number;
}>;
export function assertProviderModelRequestPolicy(provider: unknown, requireExplicit?: boolean): void;
export const thirdPartyProviderRequestMaxRetries: 4;
export const thirdPartyProviderStreamMaxRetries: 5;
export function assertProviderModelRetryPolicy(provider: unknown): void;
export function providerModelRequestTimeouts(): {
  stream_idle_timeout_ms: number;
  websocket_connect_timeout_ms: number;
};
