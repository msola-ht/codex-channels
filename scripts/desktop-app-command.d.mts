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
  output?: Pick<NodeJS.WriteStream, "write">;
  writeMessage?: (kind: "success" | "failure" | "note", message: string) => void;
  inspectDesktopApp?: () => DesktopAppInspection;
  restartAppServer?: () => Promise<void>;
  probeBridge?: (endpoint: string) => Promise<boolean>;
  openDesktop?: (path: string, endpoint: string) => void | Promise<void>;
}

export const desktopAppCommandUsage: string;
export function runDesktopAppCommand(
  args: string[],
  options?: DesktopAppCommandOptions,
): Promise<Record<string, unknown>>;
export function inspectMacDesktopApp(options?: {
  environment?: NodeJS.ProcessEnv;
  candidates?: string[];
}): DesktopAppInspection;
export function inspectWindowsDesktopApp(options?: {
  environment?: NodeJS.ProcessEnv;
  inspectInstallation?: () => {
    installed?: boolean;
    executablePath?: string | null;
    resourcePath?: string | null;
    version?: string | null;
    running?: boolean | null;
  };
}): DesktopAppInspection;
export function openWindowsDesktopApp(
  path: string,
  endpoint: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    spawnProcess?: typeof import("node:child_process").spawn;
    startupConfirmationMs?: number;
  },
): Promise<void>;
