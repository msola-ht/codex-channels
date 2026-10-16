export interface RelayReasoningProbeInput {
  revision: string;
  model: string;
  protocol: "chat" | "responses";
}
export interface RelayReasoningProbeResult extends RelayReasoningProbeInput {
  observedAtMs: number;
  rows: Array<{
    mode: "passthrough" | "off-reasoning-effort" | "off-reasoning-enabled" | "off-reasoning-effort-field" | "off-thinking" | "off-enable-thinking" | "off-chat-template-thinking" | "off-google-thinking-budget" | "off-reasoning-enabled-thinking";
    status: "completed" | "incomplete" | "failed" | "timeout" | "not_run";
    httpStatus: number | null;
    reasoningText: boolean | null;
    reasoningTokens: number | null;
    outputTokens: number | null;
    responseModel: string | null;
  }>;
  stoppedReason: null | "timeout" | "material_changed";
}
export type RelayReasoningProbeEvent =
  | { type: "progress"; result: RelayReasoningProbeResult; currentMode: RelayReasoningProbeResult["rows"][number]["mode"] | null }
  | { type: "result"; result: RelayReasoningProbeResult }
  | { type: "error"; code: string };
export function probeRelayReasoning(input: RelayReasoningProbeInput, options?: {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (event: Extract<RelayReasoningProbeEvent, { type: "progress" }>, signal: AbortSignal) => void | Promise<void>;
}): Promise<RelayReasoningProbeResult>;
