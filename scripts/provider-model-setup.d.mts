export function runProviderModelSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  prompts?: typeof import("@clack/prompts");
  output?: Pick<NodeJS.WriteStream, "write">;
  provider?: string;
}): Promise<{ action: string; activation?: string }>;
/** 选择精确账户和模型并单独确认费用；诊断不写配置。 */
export function runProviderWebSearchSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  prompts?: typeof import("@clack/prompts");
  output?: Pick<NodeJS.WriteStream, "write">;
  provider?: string;
}): Promise<{ action: string; activation?: string }>;
