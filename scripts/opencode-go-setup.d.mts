import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";

export interface OpenCodeGoSetupPrompter {
  select(allowBack: boolean): Promise<"switching" | "exclusive" | "restore" | "back">;
  secret(message: string): Promise<string>;
  confirm(message: string, initialValue: boolean): Promise<boolean>;
}

export function runOpenCodeGoSetup(options?: {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  fetchImpl?: typeof fetch;
  downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{
    catalog: { models: Array<Record<string, unknown>> };
    sha256: string;
  }>;
  prompts?: {
    select(options: unknown): Promise<unknown>;
    password(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  prompter?: OpenCodeGoSetupPrompter;
  configureRole?: (
    provider: ManagedModelProviderId,
    model: string | undefined,
    environment: NodeJS.ProcessEnv,
  ) => unknown | Promise<unknown>;
}): Promise<
  | { action: "back" }
  | { action: "restored"; configPath: string; profilePath: string; markerPath: string; catalogPath: string }
  | { action: "configured"; mode: "switching" | "exclusive"; configPath: string; profilePath: string; markerPath: string; catalogPath: string }
  | undefined
>;
