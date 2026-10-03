import type { ClineRelayCatalog, ClineRelayCatalogSnapshot } from "./cline-relay-catalog.mjs";
export type { ClineRelayModel, ClineRelayCatalog, ClineRelayCatalogSnapshot } from "./cline-relay-catalog.mjs";
export { clineRelayCatalogPath, readClineRelayCatalog, clineRelayReasoningEfforts } from "./cline-relay-catalog.mjs";
export function parseClineRelayCatalog(source: string, commit: string, downloadedAt?: number): ClineRelayCatalog;
export function downloadClineRelayCatalog(environment?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ClineRelayCatalog>;
export function saveClineRelayCatalog(catalog: ClineRelayCatalog, environment?: NodeJS.ProcessEnv): ClineRelayCatalogSnapshot;
