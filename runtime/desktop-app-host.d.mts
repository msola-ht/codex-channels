import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface MacDesktopAppAttachment {
  readonly key: string;
  readonly appPath: string;
  readonly pipePath: string;
  readonly toolsEnabled: boolean;
  readonly resourcesPath: string;
  readonly nodePath: string;
  readonly nativeCodexPath: string;
}

export const macDesktopAppPluginEnabledConfigKey: string;

export function validateMacDesktopAppAttachment(options: {
  appPath: string;
  pipePath: string;
  toolsEnabled: boolean;
  codexBinary: string;
  environment?: NodeJS.ProcessEnv;
}): MacDesktopAppAttachment;

export function parseMacDesktopAppToolsEnabled(args: readonly string[]): boolean;

export function spawnMacDesktopHostedCodex(
  attachment: MacDesktopAppAttachment,
  args: readonly string[],
  options: SpawnOptions,
  spawnProcess?: typeof import("node:child_process").spawn,
): ChildProcess;
