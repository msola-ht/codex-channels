import type { ManagedModelProviderId } from "./model-provider-definitions.mjs";

export interface AppServerTopology {
  primaryProvider: string;
  managedProviders: ManagedModelProviderId[];
  socketPaths: string[];
}

export interface InspectedAppServerTopology {
  version: 4;
  pid: number;
  primaryProvider: string;
  managedProviders: ManagedModelProviderId[];
  socketPaths: string[];
  runningProviders: ManagedModelProviderId[];
  releasedProviders: ManagedModelProviderId[];
  leasedProviders: ManagedModelProviderId[];
}

export interface AppServerProviderLease {
  close(): Promise<void>;
}

export type AppServerProviderReleaseResult =
  | { released: true; reason: "released" }
  | { released: false; reason: "leased" | "not-running" };

export type AppServerSupervisorInspection =
  | { status: "missing" }
  | { status: "incompatible" }
  | { status: "ready"; topology: InspectedAppServerTopology };

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
export function inspectAppServerSupervisorState(
  primarySocketPath: string,
): Promise<AppServerSupervisorInspection>;
export function ensureAppServerProvider(
  primarySocketPath: string,
  provider: string,
): Promise<void>;
export function acquireAppServerProviderLease(
  primarySocketPath: string,
  provider: string,
): Promise<AppServerProviderLease>;
export function releaseAppServerProvider(
  primarySocketPath: string,
  provider: string,
): Promise<AppServerProviderReleaseResult>;
export function sameAppServerTopology(
  actual: InspectedAppServerTopology | undefined,
  expected: AppServerTopology,
): boolean;
export function prepareAppServerSocketPaths(socketPaths: string[]): Promise<void>;
export function appServerSocketAcceptsWebSocket(socketPath: string): Promise<boolean>;
