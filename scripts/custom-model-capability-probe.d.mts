export type CustomModelProbeCapability = "applyPatch" | "toolSearch" | "webSearch";
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
  /** 单项探测总预算含代理发现及正文读取，默认及上限45000ms；原生搜索单请求共用总预算，其他请求最多15000ms。 */
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
/** 补丁/客户端检索为短非流式模拟；原生搜索为单次流式真实搜索，只有完成的结构化搜索调用才证明执行。 */
export function probeCustomModelCapabilities(input: CustomModelCapabilityProbeInput): Promise<CustomModelCapabilityProbeResult>;
export interface NativeModelWebSearchProbeInput extends Omit<CustomModelCapabilityProbeInput, "capability" | "reasoningEffort"> {
  reasoningEffort: CustomModelProbeReasoningEffort | "enabled" | null;
  /** 可信配置解析结果，禁止直接接受浏览器字段。 */
  requestContext: {
    clinePass?: boolean;
    clineRequestProfile?: import("../runtime/chat-reasoning.mjs").ClinePassRequestProfile;
    chatgpt?: boolean;
    reasoningEfforts?: string[];
    headers?: Record<string, string>;
    sampling?: import("../runtime/model-catalog.mjs").SamplingParameters;
  };
}
export function probeNativeWebSearch(input: NativeModelWebSearchProbeInput): Promise<Omit<CustomModelCapabilityProbeResult, "reasoningEffort" | "capability"> & {
  capability: "webSearch";
  reasoningEffort: NativeModelWebSearchProbeInput["reasoningEffort"];
}>;
