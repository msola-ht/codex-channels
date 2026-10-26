export function withThirdPartyLocalTools(catalog: unknown, environment?: NodeJS.ProcessEnv): { models: Record<string, unknown>[] };
export function withThirdPartyRuntimeTools(catalog: unknown, environment?: NodeJS.ProcessEnv): { models: Record<string, unknown>[] };
export function writeThirdPartyRuntimeModelCatalog(sourcePath: string, dataDir: string, provider: string, environment?: NodeJS.ProcessEnv): string;
