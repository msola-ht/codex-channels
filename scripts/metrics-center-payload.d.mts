export interface IngestRequestMetric {
  localId: number;
  provider: string;
  recordedAtMs: number;
  [key: string]: unknown;
}

export interface IngestSubagentThread {
  threadId: string;
  parentThreadId: string | null;
  parentTurnId?: string | null;
  agentPath: string | null;
  recordedAtMs: number;
}

export interface IngestPayload {
  deviceId: string;
  deviceName?: string;
  requestMetrics: IngestRequestMetric[];
  subagentThreads: IngestSubagentThread[];
}

export type IngestPayloadResult =
  | ({ ok: true } & IngestPayload)
  | { ok: false; error: string };

export function parseIngestPayload(body: unknown): IngestPayloadResult;
