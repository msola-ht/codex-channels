export interface ModelBaseProvenance { model: string; cliVersion: string; command: string }
export interface ModelBaseCatalog { models: Record<string, unknown>[] }
export const modelBaseMaximumBytes: number;
export const modelBaseCommand: string;
export const sourceModelIdentity: RegExp;
export class ModelBaseSnapshotError extends Error { readonly code: "invalid_catalog" | "unavailable" }
export function modelBaseSnapshotPath(environment?: NodeJS.ProcessEnv): string;
export function withModelBaseSnapshotLock<T>(environment: NodeJS.ProcessEnv | undefined, operation: () => Promise<T>): Promise<T>;
export function validateModelBaseCatalog(catalog: unknown): ModelBaseCatalog;
export function encodeModelBaseSnapshot(catalog: ModelBaseCatalog, provenance: ModelBaseProvenance): string;
export function readModelBaseSnapshot(environment?: NodeJS.ProcessEnv): {
  path: string; bytes: string; sourceRevision: string; revision: string; source: "bundled" | "saved"; schemaVersion: number;
  catalog: ModelBaseCatalog; provenance: ModelBaseProvenance;
};
export function readDeepseekModelTemplateCatalog(environment?: NodeJS.ProcessEnv, base?: ModelBaseCatalog): ModelBaseCatalog;
