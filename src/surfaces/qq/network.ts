import type { Agent } from "node:http";
import type { Readable } from "node:stream";

/** Network resources owned by one future QQ connection generation. */
export interface QqNetwork {
  fetchImpl: typeof fetch;
  downloadAttachment(url: URL, signal: AbortSignal, beforeDownload: () => void, timeoutMs?: 30_000 | 60_000): Promise<{ stream: Readable; contentLength?: number }>;
  /** Credential-free HTTPS PUT to one validated, pinned public destination; no redirects/retries. */
  uploadPart(url: URL, bytes: Uint8Array, signal: AbortSignal, beforeSend: () => undefined): Promise<void>;
  /** Same credential-free pinned PUT, preserving the declared image MIME and requiring a file-MD5 ETag. */
  uploadImageMaterial(url: URL, bytes: Uint8Array, contentType: "image/png" | "image/jpeg", signal: AbortSignal, beforeSend: () => undefined): Promise<{ etag: string }>;
  agentForUrl(url: string, signal: AbortSignal): Agent | undefined;
  releaseAgent(agent: Agent): Promise<void>;
  close(): Promise<void>;
}
