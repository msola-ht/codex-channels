export type CustomProviderUpstreamWireApi = "responses" | "chat_completions";

export const customProviderUpstreamWireApis: readonly CustomProviderUpstreamWireApi[];
export const defaultCustomProviderUpstreamWireApi: CustomProviderUpstreamWireApi;

export function customProviderUpstreamMetadataPath(environment: NodeJS.ProcessEnv | undefined, provider: string): string;
export function readCustomProviderUpstreamWireApi(
  environment: NodeJS.ProcessEnv | undefined,
  provider: string,
): CustomProviderUpstreamWireApi;
export function writeCustomProviderUpstreamWireApi(
  environment: NodeJS.ProcessEnv | undefined,
  provider: string,
  upstreamWireApi: CustomProviderUpstreamWireApi,
): void;
export function removeCustomProviderUpstreamMetadata(environment: NodeJS.ProcessEnv | undefined, provider: string): void;
