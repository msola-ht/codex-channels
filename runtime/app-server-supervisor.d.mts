import type { ManagedModelProviderId } from "./model-provider-definitions.mjs";

export interface AppServerTopology {
  primaryProvider: string;
  managedProviders: ManagedModelProviderId[];
  socketPaths: string[];
}

export interface InspectedAppServerTopology {
  version: 3;
  pid: number;
  primaryProvider: string;
  managedProviders: ManagedModelProviderId[];
  socketPaths: string[];
  runningProviders: ManagedModelProviderId[];
  releasedProviders: ManagedModelProviderId[];
}

export class AppServerSupervisorOwner {
  constructor(
    primarySocketPath: string,
    topology: AppServerTopology,
    options?: {
      ensureProvider?: (provider: string) => Promise<void>;
      releaseProvider?: (provider: string) => Promise<boolean>;
    },
  );
  start(): Promise<void>;
  close(): Promise<void>;
}

export function appServerSupervisorSocketPath(primarySocketPath: string): string;
export function inspectAppServerSupervisor(
  primarySocketPath: string,
): Promise<InspectedAppServerTopology | undefined>;
export function ensureAppServerProvider(
  primarySocketPath: string,
  provider: string,
): Promise<void>;
export function releaseAppServerProvider(
  primarySocketPath: string,
  provider: string,
): Promise<boolean>;
export function sameAppServerTopology(
  actual: InspectedAppServerTopology | undefined,
  expected: AppServerTopology,
): boolean;
export function prepareAppServerSocketPaths(socketPaths: string[]): Promise<void>;
export function appServerSocketAcceptsWebSocket(socketPath: string): Promise<boolean>;
