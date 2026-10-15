export const modelRequestPolicy: Readonly<{
  preparationTimeoutMs: number;
  headersTimeoutMs: number;
  streamIdleTimeoutMs: number;
  websocketConnectTimeoutMs: number;
  bodyReadTimeoutMs: number;
  errorBodyTimeoutMs: number;
  deliveryTimeoutMs: number;
  terminalDeliveryTimeoutMs: number;
}>;
export function assertProviderModelRequestPolicy(provider: unknown, requireExplicit?: boolean): void;
export function providerModelRequestTimeouts(): {
  stream_idle_timeout_ms: number;
  websocket_connect_timeout_ms: number;
};
