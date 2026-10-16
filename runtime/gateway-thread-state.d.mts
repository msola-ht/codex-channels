export const threadStateReadTimeoutMs: number;

export type GatewayThreadState =
  | { threadId: string; status: "active" | "idle" | "systemError" | "notLoaded"; observedAtMs: number }
  | { threadId: string; status: "unknown"; reason: "gateway_unavailable" | "provider_unavailable" | "thread_unavailable" | "timeout" | "invalid_response" };

export class GatewayThreadStateServer {
  constructor(configPath: string, readStates: (threadIds: readonly string[], signal: AbortSignal) => Promise<readonly GatewayThreadState[]>);
  start(): Promise<void>;
  close(): Promise<void>;
}

export function gatewayThreadStateSocketPath(configPath: string): string;
export function requestGatewayThreadStates(configPath: string, threadIds: readonly string[], signal?: AbortSignal): Promise<GatewayThreadState[]>;
