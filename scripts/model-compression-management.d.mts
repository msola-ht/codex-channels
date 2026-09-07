import type { writeManagedModelCompressionGlobal } from "../runtime/model-provider-runtime.mjs";

export interface ModelCompressionChangeInput {
  model: string;
  autoCompactPercent: number;
}

export interface ModelCompressionImportEntry {
  model: string;
  displayName: string;
  contextWindow: number;
  autoCompactPercent?: number;
  providers: string[];
  perProvider?: Record<string, number | undefined>;
  conflicts?: boolean;
  windowConflict?: boolean;
}

export interface ModelCompressionChangePreview {
  model: { id: string; displayName: string; contextWindow: number };
  autoCompactPercent: number;
  autoCompactLimit: number;
  providers: string[];
  willChange: boolean;
  conflicts: boolean;
  overridden: Array<{ provider: string; previousPercent: number }>;
  windowConflict: boolean;
  activation: "restart-app-server";
}

export interface ModelCompressionChangeOptions {
  environment?: NodeJS.ProcessEnv;
  loadCompression?: (environment: NodeJS.ProcessEnv) => ModelCompressionImportEntry[];
  writeCompression?: typeof writeManagedModelCompressionGlobal;
  withFileLock?: typeof import("../runtime/private-file-lock.mjs").withPrivateFileLock;
}

export class ModelCompressionManagementError extends Error {
  code: string;
  field: string;
}

export function previewModelCompressionChange(
  input: ModelCompressionChangeInput,
  options?: Pick<ModelCompressionChangeOptions, "environment" | "loadCompression">,
): ModelCompressionChangePreview;

export function applyModelCompressionChange(
  input: ModelCompressionChangeInput,
  options?: ModelCompressionChangeOptions,
): Promise<{ action: "updated" } & ModelCompressionChangePreview>;

export function projectModelCompression(
  models: ModelCompressionImportEntry[],
): Array<{
  id: string;
  displayName: string;
  contextWindow: number;
  providers: string[];
  autoCompactPercent?: number;
  conflicts?: boolean;
  windowConflict?: boolean;
  perProvider?: Record<string, number>;
}>;
