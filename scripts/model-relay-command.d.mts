export const modelRelayUsage: string;
export interface ModelRelayCommand { host?: string; enabled?: boolean; command: "listen" | "status" | "providers" | "callers" | "issue" | "delete" | "rotate" | "disable" | "enable" | "edit"; name?: string; models?: string[]; caller?: string; key?: string; reasoning?: "passthrough" | "off" }
export function parseModelRelayCommand(args: string[]): ModelRelayCommand;
export function manageModelRelay(input: ModelRelayCommand, environment?: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
export function runModelRelayCommand(args: string[]): Promise<void>;
