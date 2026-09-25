export interface ResponsesWebSocketProbeInput {
  baseUrl: string; apiKey: string; model: string; reasoningEffort?: string;
  mode?: "prewarm" | "generate"; environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal; timeoutMs?: number;
}
export interface ResponsesWebSocketProbeResult {
  status: "prewarm" | "verified" | "inconclusive" | "cancelled";
  reason: string; connected: boolean; httpStatus?: number;
}
export function probeResponsesWebSocket(input: ResponsesWebSocketProbeInput): Promise<ResponsesWebSocketProbeResult>;
