import { usesOpenAiAccount } from "../conversation-core/index.js";

let configuredCustomPrimaryProviderId: string | undefined;

export function setConfiguredCustomPrimaryProviderId(providerId: string | undefined): void {
  configuredCustomPrimaryProviderId = providerId;
}

export function formatProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "opencode-go") return "OpenCode Go";
  const normalized = provider.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 64) : "未知提供商";
}

export function formatCodexProviderLabel(provider?: string): string {
  return provider === undefined || provider === "openai"
    ? "OpenAI 官方"
    : provider === configuredCustomPrimaryProviderId
      ? `${formatProviderLabel(provider)} · 自定义`
      : formatProviderLabel(provider);
}

export function supportsFastMode(modelProvider?: string): boolean {
  return usesOpenAiAccount(modelProvider)
    || (modelProvider !== undefined && modelProvider === configuredCustomPrimaryProviderId);
}
