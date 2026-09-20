import type { ProxySettings } from "./network-proxy.mjs";
export const codexProxyFields: readonly (keyof ProxySettings)[];
export interface CodexProxySnapshot { path: string; content: string | null; settings: ProxySettings; }
export function readCodexProxySnapshot(environment?: NodeJS.ProcessEnv): CodexProxySnapshot;
export function readCodexProxySettings(environment?: NodeJS.ProcessEnv): ProxySettings;
export function renderCodexProxySettings(snapshot: CodexProxySnapshot, changes: Partial<Record<keyof ProxySettings, string | null>>): string;
export function writeCodexProxySettings(changes: Partial<Record<keyof ProxySettings, string | null>>, environment?: NodeJS.ProcessEnv): { configPath: string; changed: boolean };
export function validateCodexProxyValue(field: string, value: string): string | undefined;
