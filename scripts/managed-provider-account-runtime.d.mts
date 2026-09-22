import type { AppServerProviderReleaseResult, AppServerSupervisorInspection } from "../runtime/app-server-supervisor.mjs";

export interface ManagedAccountRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  resolvePrimarySocket?: (environment: NodeJS.ProcessEnv) => string;
  inspectSupervisor?: (socketPath: string) => Promise<AppServerSupervisorInspection>;
  releaseProvider?: (socketPath: string, provider: string) => Promise<AppServerProviderReleaseResult>;
}
export interface ManagedAccountRuntimePlan {
  provider: string;
  primarySocketPath: string;
  running: boolean;
}
export function managedAccountPrimarySocket(environment: NodeJS.ProcessEnv): string;
export function inspectManagedAccountRuntime(provider: string, options?: ManagedAccountRuntimeOptions): Promise<ManagedAccountRuntimePlan>;
export function releaseManagedAccountRuntime(plan: ManagedAccountRuntimePlan, options?: ManagedAccountRuntimeOptions): Promise<"stopped" | "not-running" | "in-use">;
export function stopManagedAccountForRemoval(provider: string, options?: ManagedAccountRuntimeOptions): Promise<"stopped" | "not-running">;
