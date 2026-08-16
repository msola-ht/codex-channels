import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";
import type { CodexUserConfigEdit } from "./codex-user-config.mjs";

export interface ModelProviderDefaultSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  prompts?: Record<string, unknown>;
  prompter?: {
    selectProvider(): Promise<ManagedModelProviderId | "back">;
    selectModel(provider: {
      provider: ManagedModelProviderId;
      displayName: string;
      model: string;
      mode: "switching" | "exclusive";
      models: string[];
    }): Promise<string>;
  };
  writeConfigEdits?: (
    environment: NodeJS.ProcessEnv,
    edits: CodexUserConfigEdit[],
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
      mode: "switching" | "exclusive";
    }
>;
