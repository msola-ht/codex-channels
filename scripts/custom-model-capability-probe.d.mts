export type CustomModelProbeCapability = "applyPatch" | "toolSearch";
export type CustomModelProbeReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface CustomModelCapabilityCheck {
  capability: CustomModelProbeCapability;
  status: "supported" | "unsupported" | "inconclusive";
  /** 固定安全文案，不含上游正文。 */
  reason: string;
  httpStatus?: number;
}
export interface CustomModelCapabilityProbeInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  upstreamWireApi: "responses" | "chat_completions";
  capability: CustomModelProbeCapability;
  /** 所有请求使用用户选择的强度；此探测不验证思考控制本身。 */
  reasoningEffort: CustomModelProbeReasoningEffort;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 单项探测的总预算，含代理发现及正文读取；默认及上限 45000ms，每请求最多15000ms。 */
  timeoutMs?: number;
}
export interface CustomModelCapabilityProbeResult {
  model: string;
  upstreamWireApi: "responses" | "chat_completions";
  capability: CustomModelProbeCapability;
  reasoningEffort: CustomModelProbeReasoningEffort;
  status: "completed" | "cancelled";
  /** cancelled 时为 inconclusive；调用方必须拒绝应用取消结果。 */
  check: CustomModelCapabilityCheck;
}
/** 短非流式探测；不证明流式、上下文容量或并发能力，不执行返回的工具。 */
export function probeCustomModelCapabilities(input: CustomModelCapabilityProbeInput): Promise<CustomModelCapabilityProbeResult>;
