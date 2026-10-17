import type { writeManagedModelWindow } from "../runtime/model-provider-runtime.mjs";

export type ModelWindowChangeInput = {
  provider: string;
  model: string;
} & ({ contextWindow: number; windowPercent?: never } | { windowPercent: number; contextWindow?: never });

export interface ModelWindowImportEntry {
  provider: string;
  model: string;
  displayName: string;
  contextWindow: number;
  maxContextWindow: number;
  windowPercent?: number;
  providers: string[];
}

export interface ModelWindowChangePreview {
  provider: string;
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
  activation: "restart-app-server";
}

export interface ModelWindowChangeOptions {
  environment?: NodeJS.ProcessEnv;
  loadWindow?: (environment: NodeJS.ProcessEnv) => ModelWindowImportEntry[];
  writeWindow?: typeof writeManagedModelWindow;
  withFileLock?: typeof import("../runtime/private-file-lock.mjs").withPrivateFileLock;
}

export class ModelWindowManagementError extends Error {
  code: string;
  field: string;
}

export function applyModelWindowChange(
  input: ModelWindowChangeInput,
  options?: ModelWindowChangeOptions,
): Promise<{ action: "updated" } & ModelWindowChangePreview>;
