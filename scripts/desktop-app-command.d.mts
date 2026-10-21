export interface DesktopAppInspection {
  installed: boolean;
  path: string | null;
  version: string | null;
  running: boolean | null;
  compatible: boolean;
  reason: string | null;
}

export interface DesktopAppCommandOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  output?: Pick<NodeJS.WriteStream, "write">;
  writeMessage?: (kind: "success" | "failure" | "note", message: string) => void;
  inspectDesktopApp?: (options?: { signal?: AbortSignal }) => DesktopAppInspection | Promise<DesktopAppInspection>;
  restartAppServer?: () => Promise<void>;
  confirmEnable?: (preview: { provider: string; port: number | null }) => boolean | Promise<boolean>;
  probeBridge?: (endpoint: string, options?: { signal?: AbortSignal }) => Promise<boolean>;
  inspectSupervisorState?: typeof import("../runtime/app-server-supervisor.mjs").inspectAppServerSupervisorState;
  acquireProviderLease?: typeof import("../runtime/app-server-supervisor.mjs").acquireAppServerProviderLease;
  inspectActiveThreads?: (options: {
    socketPath: string;
    codexBinary: string;
    signal?: AbortSignal;
  }) => Promise<number>;
  openDesktop?: (path: string, endpoint: string, provider: string, options?: { signal?: AbortSignal }) => void | Promise<void>;
}

export const desktopAppCommandUsage: string;
export function runDesktopAppCommand(
  args: string[],
  options?: DesktopAppCommandOptions,
): Promise<Record<string, unknown>>;
export function inspectMacDesktopApp(options?: {
  environment?: NodeJS.ProcessEnv;
  candidates?: string[];
  signal?: AbortSignal;
}): Promise<DesktopAppInspection>;
export function inspectWindowsDesktopApp(options?: {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  inspectInstallation?: () => {
    installed?: boolean;
    executablePath?: string | null;
    resourcePath?: string | null;
    version?: string | null;
    running?: boolean | null;
  } | Promise<{
    installed?: boolean;
    executablePath?: string | null;
    resourcePath?: string | null;
    version?: string | null;
    running?: boolean | null;
  }>;
}): Promise<DesktopAppInspection>;
export function openWindowsDesktopApp(
  path: string,
  endpoint: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    spawnProcess?: typeof import("node:child_process").spawn;
    startupConfirmationMs?: number;
    signal?: AbortSignal;
  },
): Promise<void>;
