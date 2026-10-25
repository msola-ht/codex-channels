import type { Agent } from "node:http";
import type { Readable } from "node:stream";

/** Network resources owned by one future QQ connection generation. */
export interface QqNetwork {
  fetchImpl: typeof fetch;
  downloadAttachment(url: URL, signal: AbortSignal, beforeDownload: () => void): Promise<{ stream: Readable; contentLength?: number }>;
  agentForUrl(url: string, signal: AbortSignal): Agent | undefined;
  releaseAgent(agent: Agent): Promise<void>;
  close(): Promise<void>;
}
