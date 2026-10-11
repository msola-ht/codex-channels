export interface ResponsesToolSearchProbeInput {
  baseUrl: string; apiKey: string; model: string; environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 从代理解析到完整正文读取的截止时间；正整数毫秒，默认 15000。 */
  timeoutMs?: number;
}
export interface ResponsesToolSearchProbeResult {
  status: "supported" | "unsupported" | "inconclusive" | "cancelled";
  reason: string; httpStatus?: number;
}
export function probeResponsesToolSearch(input: ResponsesToolSearchProbeInput): Promise<ResponsesToolSearchProbeResult>;
