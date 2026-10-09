export interface OwnedProcessInvocation {
  file: string;
  args: readonly string[];
  windowsVerbatimArguments?: boolean;
}
export function ownedProcessInvocation(invocation: OwnedProcessInvocation, environment?: NodeJS.ProcessEnv, socketPath?: string): OwnedProcessInvocation;
export function codexProcessInvocation(command: string, args: readonly string[], environment?: NodeJS.ProcessEnv): OwnedProcessInvocation;
