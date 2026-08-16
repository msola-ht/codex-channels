import type { CodexUserConfigEdit } from "./codex-user-config.mjs";
import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";

export const deepseekSetupScriptUrl: string;

export interface DeepseekSetupPrompter {
  ask(label: string): Promise<string>;
  secret(label: string): Promise<string>;
  confirm(label: string, defaultValue: boolean): Promise<boolean>;
  close(): void;
}

export interface DeepseekSetupPrompts {
  select(options: unknown): Promise<unknown>;
  text(options: unknown): Promise<unknown>;
  password(options: unknown): Promise<unknown>;
  confirm(options: unknown): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface DeepseekSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  fetchImpl?: typeof fetch;
  prompter?: DeepseekSetupPrompter;
  prompts?: DeepseekSetupPrompts;
  configureRole?: (
    provider: ManagedModelProviderId,
    model: string | undefined,
    environment: NodeJS.ProcessEnv,
  ) => unknown | Promise<unknown>;
  writeConfigEdits?: (
    environment: NodeJS.ProcessEnv,
    edits: CodexUserConfigEdit[],
  ) => Promise<void>;
}

export interface DeepseekSetupResult {
  mode: "switching" | "exclusive" | "restored";
  configPath: string;
  profilePath: string;
  gatewayProfilePath: string;
  catalogPath: string;
  backupPath: string;
}

export interface DeepseekSetupBackResult {
  action: "back";
  mode?: never;
}

export interface DeepseekSetupAutoCompactResult {
  action: "auto-compact";
  autoCompactPercent: number | undefined;
  mode?: never;
}

export function runDeepseekSetup(options?: DeepseekSetupOptions): Promise<
  | DeepseekSetupResult
  | DeepseekSetupBackResult
  | DeepseekSetupAutoCompactResult
  | undefined
>;
export function downloadDeepseekCatalog(
  fetchImplementation: typeof fetch,
  options?: {
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{
  catalog: { models: Array<Record<string, unknown>> };
  sha256: string;
}>;
export function extractDeepseekCatalog(script: string): { models: Array<Record<string, unknown>> };
