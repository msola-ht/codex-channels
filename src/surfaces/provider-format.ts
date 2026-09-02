import { usesOpenAiAccount } from "../conversation-core/index.js";
import {
  isOpencodeGoProvider,
  opencodeGoProviderDisplayName,
} from "../../runtime/opencode-go-accounts.mjs";

let configuredCustomPrimaryProviderIds = new Set<string>();

export function setConfiguredCustomPrimaryProviderId(
  providerId: string | readonly string[] | undefined,
): void {
  configuredCustomPrimaryProviderIds = new Set(
    providerId === undefined ? [] : typeof providerId === "string" ? [providerId] : providerId,
  );
}

export function formatProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "deepseek") return "DeepSeek";
  if (isOpencodeGoProvider(provider)) {
    return opencodeGoProviderDisplayName(provider);
  }
  const normalized = provider.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 64) : "未知提供商";
}

export function formatCodexProviderLabel(provider?: string): string {
  return provider === undefined || provider === "openai"
    ? "OpenAI 官方"
    : configuredCustomPrimaryProviderIds.has(provider)
      ? `${formatProviderLabel(provider)} · 自定义`
      : formatProviderLabel(provider);
}

export function supportsFastMode(modelProvider?: string): boolean {
  return usesOpenAiAccount(modelProvider)
    || (modelProvider !== undefined && configuredCustomPrimaryProviderIds.has(modelProvider));
}
