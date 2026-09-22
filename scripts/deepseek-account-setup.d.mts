export function runDeepseekSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  prompts?: unknown;
  output?: { write(value: string): unknown };
  action?: string;
  accountId?: string;
  allowBack?: boolean;
}): Promise<unknown>;
export function runDeepseekAccountCli(args: string[], options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: unknown;
}): Promise<unknown>;
