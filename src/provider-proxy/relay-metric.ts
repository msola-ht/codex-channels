import type { DirectChatUsage } from "../model-api/index.js";

export interface RelayMetric extends DirectChatUsage {
  source: "relay";
  threadId: null;
  turnId: null;
  relayRequestId: string;
  callerId: string;
  keyId: string;
  credentialGeneration: number;
  provider: string;
  requestModel: string;
  responseModel?: string;
  responseFormat: "json" | "sse";
  status: "completed" | "incomplete" | "failed";
  deliveryStatus: "finished" | "disconnected" | "failed";
  requestStartedAtMs: number;
  responseCompletedAtMs: number;
  totalDurationMs: number;
  firstTokenMs?: number;
  httpStatus?: number;
  errorCode?: string;
}
