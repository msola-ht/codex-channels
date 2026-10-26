export type ModelBaseErrorCode = "invalid_input" | "invalid_catalog" | "unavailable" | "stale_revision" | "export_failed" | "write_failed" | "busy" | "login_required";
export function assertModelBaseLogin(binary: string, environment?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void>;
export class ModelBaseError extends Error { readonly code: ModelBaseErrorCode; readonly reason?: string; constructor(code: ModelBaseErrorCode, reason?: string, options?: ErrorOptions) }
export interface ModelBaseSummary { model: string; cliVersion: string; command: string }
export interface ModelBaseState extends ModelBaseSummary { revision: string; source: "bundled" | "saved" }
export type ModelBaseFieldValue = { present: false } | { present: true; value: unknown };
export interface ModelBaseUpdatePreview {
  revision: string; candidateToken: string; expiresAt: number; changed: boolean;
  before: ModelBaseSummary; after: ModelBaseSummary;
  changes: Array<{field: string; before: ModelBaseFieldValue; after: ModelBaseFieldValue}>;
}
export interface ModelBaseUpdateInput { revision: string; candidateToken: string }
export interface ModelBaseUpdateResult { status: "updated" | "unchanged"; model: string; revision: string; backupPath?: string; consistency: "confirmed" | "unconfirmed" }
export function loadModelBase(environment?: NodeJS.ProcessEnv): Promise<ModelBaseState>;
export function prepareModelBaseUpdate(input: {revision: string}, environment?: NodeJS.ProcessEnv, options?: {signal?: AbortSignal}): Promise<ModelBaseUpdatePreview>;
export function getModelBaseUpdatePreview(input: ModelBaseUpdateInput, environment?: NodeJS.ProcessEnv): Promise<ModelBaseUpdatePreview>;
export function applyModelBaseUpdate(input: ModelBaseUpdateInput, environment?: NodeJS.ProcessEnv, options?: {signal?: AbortSignal}): Promise<ModelBaseUpdateResult>;
export function closeModelBaseExports(): Promise<void>;
export function waitForModelBaseExportsExit(): Promise<void>;
