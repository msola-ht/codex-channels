import type { CodexUserConfigTransactionClient } from "./codex-user-config.mjs";

export interface OfficialLoginSetupPrompts {
  confirm(options: unknown): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface OfficialLoginSetupOptions {
  environment?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: { write(value: string): unknown };
  prompts?: OfficialLoginSetupPrompts;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient>;
  runLogin?: (options: {
    codexBinary: string;
    environment: NodeJS.ProcessEnv;
    input: NodeJS.ReadableStream;
    output: { write(value: string): unknown };
  }) => void | Promise<void>;
}

export function runOfficialLoginSetup(options?: OfficialLoginSetupOptions): Promise<
  | { mode: "official" }
  | undefined
>;
