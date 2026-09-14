import type { CodexUserConfigEdit } from "./codex-user-config.mjs";
import type { ManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";

export interface ManagedProviderDefaultChangeInput {
  provider: string;
  model: string;
  reasoningEffort: string;
  windowPercent?: number;
}

export interface ManagedProviderDefaultChangePreview {
  provider: {
    id: string;
    displayName: string;
    mode: "switching" | "exclusive";
  };
  model: {
    id: string;
    displayName: string;
    contextWindow: number;
    maxContextWindow: number;
  };
  reasoningEffort: string;
  windowPercent?: number;
  contextWindow?: number;
  willChange: boolean;
  activation: "restart-app-server";
}

export interface ManagedProviderDefaultChangeOptions {
  environment?: NodeJS.ProcessEnv;
  loadProviders?: (environment: NodeJS.ProcessEnv) => ManagedModelProviderSettings[];
  writeProfileDefault?: typeof import("../runtime/model-provider-runtime.mjs")
    .writeManagedModelProviderProfileDefault;
  writeCatalogSettings?: typeof import("../runtime/model-provider-runtime.mjs")
    .writeManagedModelProviderCatalogSettings;
  readCatalogContent?: typeof import("../runtime/model-provider-runtime.mjs")
    .readManagedModelProviderCatalogContent;
  restoreCatalogContent?: typeof import("../runtime/model-provider-runtime.mjs")
    .restoreManagedModelProviderCatalogContent;
  writeConfigEdits?: (
    environment: NodeJS.ProcessEnv,
    edits: CodexUserConfigEdit[],
    options?: { expectedVersion?: string },
  ) => Promise<void>;
  readConfigSnapshot?: typeof import("./codex-user-config.mjs").readCodexUserConfigSnapshot;
  withFileLock?: typeof import("../runtime/private-file-lock.mjs").withPrivateFileLock;
}

export class ModelProviderDefaultManagementError extends Error {
  code: string;
  field: string;
}

export function previewManagedProviderDefaultChange(
  input: ManagedProviderDefaultChangeInput,
  options?: Pick<ManagedProviderDefaultChangeOptions, "environment" | "loadProviders">,
): ManagedProviderDefaultChangePreview;

export function applyManagedProviderDefaultChange(
  input: ManagedProviderDefaultChangeInput,
  options?: ManagedProviderDefaultChangeOptions,
): Promise<{ action: "updated" } & ManagedProviderDefaultChangePreview>;
