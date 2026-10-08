export interface AppServerTopology {
  primaryProvider: string;
  managedProviders: string[];
  socketPaths: string[];
}

export interface InspectedAppServerTopology {
  version: 5;
  pid: number;
  primaryProvider: string;
  managedProviders: string[];
  socketPaths: string[];
  runningProviders: string[];
  releasedProviders: string[];
  leasedProviders: string[];
  desktopAppHostProtocolVersion?: 2;
  desktopAppProviderProtocolVersion?: 1;
  desktopAppAttached?: boolean;
  desktopAppProvider?: string;
}

export interface AppServerProviderLease {
  close(): Promise<void>;
}

export type AppServerProviderReleaseResult =
  | { released: true; reason: "released" }
  | { released: false; reason: "leased" | "not-running" };

export interface AppServerProviderSettingsSnapshot {
  fingerprint: string;
  defaultModel: string | null;
}

export type AppServerProviderSettingsResult = (
  | { applied: true; changed: boolean }
  | { applied: false; reason: "leased" | "active" }
) & { snapshot?: AppServerProviderSettingsSnapshot };

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
      applyProviderSettings?: (provider: string, signal: AbortSignal, canApply: () => boolean) => Promise<AppServerProviderSettingsResult>;
      providerSettingsSnapshot?: (provider: string) => AppServerProviderSettingsSnapshot | undefined;
      attachDesktopApp?: (attachment: {
        provider: string;
        appPath: string;
        pipePath: string;
        toolsEnabled: boolean;
      }, signal: AbortSignal, canAttach: () => boolean) => Promise<void>;
      detachDesktopApp?: () => Promise<void>;
      desktopAppProviderSelectionEnabled?: boolean;
    },
  );
  start(): Promise<void>;
  markRunning(provider: string): void;
  markReleased(provider: string): void;
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
export function acquireMacDesktopAppHostLease(
  primarySocketPath: string,
  attachment: {
    provider: string;
    pipePath: string;
    appPath: string;
    toolsEnabled: boolean;
  },
): Promise<AppServerProviderLease>;
export function releaseAppServerProvider(
  primarySocketPath: string,
  provider: string,
): Promise<AppServerProviderReleaseResult>;
export function applyAppServerProviderSettings(
  primarySocketPath: string,
  provider: string,
  signal?: AbortSignal,
): Promise<AppServerProviderSettingsResult>;
export function readAppServerProviderSettingsFingerprint(provider: string, environment?: NodeJS.ProcessEnv): string;
export function sameAppServerTopology(
  actual: InspectedAppServerTopology | undefined,
  expected: AppServerTopology,
): boolean;
export function prepareAppServerSocketPaths(socketPaths: string[]): Promise<void>;
export function appServerSocketAcceptsWebSocket(socketPath: string): Promise<boolean>;
