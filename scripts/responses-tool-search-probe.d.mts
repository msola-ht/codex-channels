export interface ResponsesToolSearchProbeInput {
  baseUrl: string; apiKey: string; model: string; environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal; timeoutMs?: number;
}
export interface ResponsesToolSearchProbeResult {
  status: "supported" | "unsupported" | "inconclusive" | "cancelled";
  reason: string; httpStatus?: number;
}
export function probeResponsesToolSearch(input: ResponsesToolSearchProbeInput): Promise<ResponsesToolSearchProbeResult>;
