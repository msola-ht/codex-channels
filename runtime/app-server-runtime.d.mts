import type {
  ConfiguredCustomSwitchingModelProvider,
  ManagedProviderAppServerRuntime,
} from "./model-provider-runtime.mjs";
import type { ManagedModelProviderId } from "./model-provider-definitions.mjs";
export interface AppServerRuntimeDescriptor {
  primarySocketPath: string;
  primaryProvider: "openai" | ManagedModelProviderId;
  managedProviders: Array<ManagedProviderAppServerRuntime | ConfiguredCustomSwitchingModelProvider>;
  customSwitchingProviders: ConfiguredCustomSwitchingModelProvider[];
  managedSocketPaths: string[];
  socketPaths: string[];
  topology: {
    primaryProvider: "openai" | ManagedModelProviderId;
    managedProviders: string[];
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
