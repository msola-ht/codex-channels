import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";
import type { CodexUserConfigEdit } from "./codex-user-config.mjs";

export interface ModelProviderDefaultSetupOptions {
  allowBack?: boolean;
  provider?: ManagedModelProviderId;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  prompts?: Record<string, unknown>;
  prompter?: {
    selectProvider(): Promise<ManagedModelProviderId | "back">;
    selectModel(provider: {
      provider: ManagedModelProviderId;
      displayName: string;
      model: string;
      reasoningEffort: string;
      mode: "switching" | "exclusive";
      models: Array<{
        model: string;
        displayName: string;
        contextWindow: number;
        reasoningEffort: string;
        reasoningEfforts: Array<{ effort: string; description: string }>;
        autoCompactLimit?: number;
        autoCompactPercent?: number;
      }>;
    }): Promise<string>;
    selectReasoningEffort(
      provider: Record<string, unknown>,
      model: Record<string, unknown>,
    ): Promise<string>;
    selectAutoCompactPercent(
      provider: Record<string, unknown>,
      model: Record<string, unknown>,
    ): Promise<number>;
  };
  readConfigSnapshot?: typeof import("./codex-user-config.mjs").readCodexUserConfigSnapshot;
  writeConfigEdits?: (
    environment: NodeJS.ProcessEnv,
    edits: CodexUserConfigEdit[],
    options?: { expectedVersion?: string },
  ) => Promise<void>;
}

export function runModelProviderDefaultSetup(
  options?: ModelProviderDefaultSetupOptions,
): Promise<
  | { action: "back" }
  | {
      action: "configured";
      provider: ManagedModelProviderId;
      model: string;
      reasoningEffort: string;
      autoCompactPercent: number;
      mode: "switching" | "exclusive";
    }
>;
