export interface OpenCodeGoSetupPrompter {
  select(allowBack: boolean): Promise<"configure" | "remove" | "back">;
  secret(message: string): Promise<string>;
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
    isCancel(value: unknown): boolean;
  };
  prompter?: OpenCodeGoSetupPrompter;
}): Promise<
  | { action: "back" }
  | { action: "removed"; profilePath: string; markerPath: string }
  | { action: "configured"; profilePath: string; markerPath: string; catalogPath: string }
>;
