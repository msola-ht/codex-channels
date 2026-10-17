import type { probeNativeWebSearch } from "./custom-model-capability-probe.mjs";
export interface ProviderWebSearchProbeInput { provider: string; model: string; revision: string }
export type ProviderWebSearchProbeResult = Awaited<ReturnType<typeof probeNativeWebSearch>> & {provider: string};
export class ProviderWebSearchProbeError extends Error {
  readonly code: "invalid_input" | "stale_revision" | "unavailable" | "credential_unavailable";
  readonly statusCode: 400 | 409 | 503;
  constructor(code: ProviderWebSearchProbeError["code"]);
}
/** 只使用当前配置的身份与模型；单请求，含解析和代理发现的总预算，默认/上限45秒。 */
export function probeConfiguredProviderWebSearch(input: ProviderWebSearchProbeInput, options?: {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ProviderWebSearchProbeResult>;
