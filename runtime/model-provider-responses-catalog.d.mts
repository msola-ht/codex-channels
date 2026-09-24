export interface ResponsesModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  supportsImages: boolean;
}
export function isResponsesProvider(id: unknown): boolean;
export function responsesProviderCatalogPath(environment: NodeJS.ProcessEnv | undefined, id: string): string;
export function validateResponsesModels(values: unknown, defaultModel: string): ResponsesModelDefinition[];
export function createResponsesModelCatalog(definitions: ResponsesModelDefinition[], defaultModel: string): {
  schemaVersion: number; defaultModel: string; definitions: ResponsesModelDefinition[]; models: Record<string, unknown>[];
};
export function readResponsesModelCatalog(environment: NodeJS.ProcessEnv | undefined, id: string): ReturnType<typeof createResponsesModelCatalog> & { path: string; revision: string };
export function responsesModelSettings(environment: NodeJS.ProcessEnv | undefined, id: string, model?: string): { catalog: ReturnType<typeof readResponsesModelCatalog>; model: string; reasoningEffort: string | null };
export function writeResponsesModelCatalog(environment: NodeJS.ProcessEnv | undefined, id: string, definitions: ResponsesModelDefinition[], model: string, expectedRevision?: string): {path: string; previous: ReturnType<typeof readResponsesModelCatalog> | undefined};
export function finishResponsesModelCatalogWrite(transaction: ReturnType<typeof writeResponsesModelCatalog>, rollback?: boolean): void;
export function removeResponsesModelCatalog(environment: NodeJS.ProcessEnv | undefined, id: string): void;

export function withResponsesModelCatalogWrite<T>(transaction: {path: string}, operation: () => Promise<T>): Promise<T>;

export function responsesProviderBackupPath(environment: NodeJS.ProcessEnv | undefined, id: string): string;
