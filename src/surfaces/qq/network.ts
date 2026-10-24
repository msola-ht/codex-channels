import type { Agent } from "node:http";

/** Network resources owned by one future QQ connection generation. */
export interface QqNetwork {
  fetchImpl: typeof fetch;
  agentForUrl(url: string, signal: AbortSignal): Agent | undefined;
  releaseAgent(agent: Agent): Promise<void>;
  close(): Promise<void>;
}
