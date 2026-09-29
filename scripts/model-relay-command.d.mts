export const modelRelayUsage: string;
export interface ModelRelayCommand { command: "status" | "callers" | "issue" | "rotate" | "disable" | "enable"; models: string[]; caller?: string; key?: string; provider?: string }
export function parseModelRelayCommand(args: string[]): ModelRelayCommand;
export function manageModelRelay(input: ModelRelayCommand, environment?: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
export function runModelRelayCommand(args: string[]): Promise<void>;
