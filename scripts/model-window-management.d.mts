import type { writeManagedModelWindowGlobal } from "../runtime/model-provider-runtime.mjs";

export interface ModelWindowChangeInput {
  model: string;
  windowPercent: number;
}

export interface ModelWindowImportEntry {
  model: string;
  displayName: string;
  contextWindow: number;
  maxContextWindow: number;
  windowPercent?: number;
  providers: string[];
  perProvider?: Record<string, number | undefined>;
  conflicts?: boolean;
  windowConflict?: boolean;
}

export interface ModelWindowChangePreview {
  model: {
    id: string;
    displayName: string;
    contextWindow: number;
    maxContextWindow: number;
  };
  windowPercent: number;
  contextWindow: number;
  providers: string[];
  willChange: boolean;
  conflicts: boolean;
  overridden: Array<{ provider: string; previousPercent: number }>;
  windowConflict: boolean;
  activation: "restart-app-server";
}

export interface ModelWindowChangeOptions {
  environment?: NodeJS.ProcessEnv;
  loadWindow?: (environment: NodeJS.ProcessEnv) => ModelWindowImportEntry[];
  writeWindow?: typeof writeManagedModelWindowGlobal;
  withFileLock?: typeof import("../runtime/private-file-lock.mjs").withPrivateFileLock;
}

export class ModelWindowManagementError extends Error {
  code: string;
  field: string;
}

export function previewModelWindowChange(
  input: ModelWindowChangeInput,
  options?: Pick<ModelWindowChangeOptions, "environment" | "loadWindow">,
): ModelWindowChangePreview;

export function applyModelWindowChange(
  input: ModelWindowChangeInput,
  options?: ModelWindowChangeOptions,
): Promise<{ action: "updated" } & ModelWindowChangePreview>;

export function projectModelWindow(
  models: ModelWindowImportEntry[],
): Array<{
  id: string;
  displayName: string;
  contextWindow: number;
  maxContextWindow: number;
  providers: string[];
  windowPercent?: number;
  conflicts?: boolean;
  windowConflict?: boolean;
  perProvider?: Record<string, number>;
}>;
