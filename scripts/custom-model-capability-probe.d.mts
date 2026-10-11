export type CustomModelProbeCapability = "text" | "tools" | "images" | "applyPatch" | "toolSearch" | "reasoningNone" | "reasoningMedium";
export interface CustomModelCapabilityCheck {
  capability: CustomModelProbeCapability;
  status: "supported" | "unsupported" | "inconclusive";
  /** 固定安全文案，不含上游正文。 */
  reason: string;
  httpStatus?: number;
}
export interface CustomModelCapabilities {
  supportsImages: boolean;
  applyPatchToolType?: "freeform";
  supportsSearchTool: boolean;
  reasoningEfforts: Array<"none" | "medium">;
  defaultReasoningEffort: "none" | "medium" | null;
}
export interface CustomModelCapabilityProbeInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  upstreamWireApi: "responses" | "chat_completions";
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 整个模型的总预算，含代理发现及正文读取；默认及上限 120000ms。 */
  timeoutMs?: number;
}
export interface CustomModelCapabilityProbeResult {
  model: string;
  upstreamWireApi: "responses" | "chat_completions";
  status: "completed" | "cancelled";
  checks: CustomModelCapabilityCheck[];
  /** cancelled 时为空能力；调用方必须拒绝应用取消结果。 */
  capabilities: CustomModelCapabilities;
}
/** 短非流式探测；不证明流式、上下文容量或并发能力，不执行返回的工具。 */
export function probeCustomModelCapabilities(input: CustomModelCapabilityProbeInput): Promise<CustomModelCapabilityProbeResult>;
