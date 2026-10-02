export const modelRelayUsage: string;
export interface ModelRelayCommand { enabledModels?: string[]; host?: string; enabled?: boolean; extraModels?: import("../runtime/model-relay-config.mjs").RelayExtraModel[]; command: "models" | "listen" | "status" | "providers" | "callers" | "issue" | "delete" | "rotate" | "disable" | "enable" | "upgrade-limits" | "upgrade-models" | "edit" | "rollback-reasoning" | "rollback-names" | "rollback-providers" | "rollback-retired"; providers?: string[]; name?: string; models?: string[]; caller?: string; key?: string; provider?: string; reasoning?: "passthrough" | "off" }
export function parseModelRelayCommand(args: string[]): ModelRelayCommand;
export function manageModelRelay(input: ModelRelayCommand, environment?: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
export function runModelRelayCommand(args: string[]): Promise<void>;
