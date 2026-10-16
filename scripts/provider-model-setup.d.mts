export function runProviderModelSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  prompts?: typeof import("@clack/prompts");
  output?: Pick<NodeJS.WriteStream, "write">;
  provider?: string;
}): Promise<{ action: string; activation?: string }>;
