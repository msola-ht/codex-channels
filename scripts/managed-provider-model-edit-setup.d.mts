export function runManagedProviderModelEditSetup(provider: string, options?: {
  environment?: NodeJS.ProcessEnv;
  prompts?: typeof import("@clack/prompts");
  output?: { write(value: string): unknown };
}): Promise<{ action: string; activation: string }>;
