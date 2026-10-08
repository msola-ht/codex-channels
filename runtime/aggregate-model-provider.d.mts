export const aggregateProviderId: "codexc-aggregate";
export const aggregateTokenEnvironmentKey: "CODEX_CONNECT_AGGREGATE_TOKEN";
/** The same eligibility rule for service topology, Gateway and native Remote. */
export function aggregateProviderMembers(
  primaryProvider: string,
  providers: readonly { provider: string }[],
): string[];
export interface AggregateMaterialFile {
  path: string;
  maximumBytes: number;
  digest: string | null;
  readMode?: "codex-config";
}
export interface AggregateModelMaterial {
  catalog: { models: Record<string, unknown>[] };
  routes: Map<string, { provider: string; model: string; apiKey: string }>;
  profiles: { provider: string; baseUrl: string }[];
  files: AggregateMaterialFile[];
  fingerprint: string;
  defaultModel: string;
  reasoningEffort?: string;
}
export function loadAggregateModelMaterial(environment: NodeJS.ProcessEnv, expectedMembers: string[]): AggregateModelMaterial;
export function aggregateProviderMaterialFiles(environment: NodeJS.ProcessEnv, expectedMembers: readonly string[]): { path: string; maximumBytes: number }[];
export function readAggregateProviderSettingsFingerprint(environment: NodeJS.ProcessEnv, expectedMembers: readonly string[]): string;
export function aggregateLaunchArguments(material: AggregateModelMaterial, dataDir: string, baseUrl: string): string[];
