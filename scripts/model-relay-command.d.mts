export const modelRelayUsage: string;
export interface ModelRelayCommand { command: "status" | "providers" | "callers" | "issue" | "rotate" | "disable" | "enable" | "upgrade-limits" | "edit" | "rollback-reasoning"; models: string[]; caller?: string; key?: string; provider?: string; reasoning?: "passthrough" | "off" }
export function parseModelRelayCommand(args: string[]): ModelRelayCommand;
export function manageModelRelay(input: ModelRelayCommand, environment?: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
export function runModelRelayCommand(args: string[]): Promise<void>;
