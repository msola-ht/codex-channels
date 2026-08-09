import type { ManagedProviderAppServerRuntime } from "./model-provider-runtime.mjs";

export interface AppServerRuntimeDescriptor {
  primarySocketPath: string;
  primaryProvider: "openai" | "deepseek";
  managedProvider?: ManagedProviderAppServerRuntime;
  managedSocketPath?: string;
  socketPaths: string[];
  topology: {
    primaryProvider: "openai" | "deepseek";
    managedProvider?: "deepseek";
    socketPaths: string[];
  };
}

export function resolvePrimaryAppServerSocketPath(
  document: Record<string, unknown>,
  dataDir: string,
): string;

export function resolveAppServerRuntime(
  document: Record<string, unknown>,
  dataDir: string,
  environment?: NodeJS.ProcessEnv,
): AppServerRuntimeDescriptor;
