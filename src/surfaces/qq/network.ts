import type { Agent } from "node:http";
import type { Readable } from "node:stream";

/** Network resources owned by one future QQ connection generation. */
export interface QqNetwork {
  fetchImpl: typeof fetch;
  downloadAttachment(url: URL, signal: AbortSignal, beforeDownload: () => void): Promise<{ stream: Readable; contentLength?: number }>;
  /** Credential-free HTTPS PUT to one validated, pinned public destination; no redirects/retries. */
  uploadPart(url: URL, bytes: Uint8Array, signal: AbortSignal, beforeSend: () => undefined): Promise<void>;
  agentForUrl(url: string, signal: AbortSignal): Agent | undefined;
  releaseAgent(agent: Agent): Promise<void>;
  close(): Promise<void>;
}
