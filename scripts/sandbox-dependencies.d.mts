export interface SandboxDependencyOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  resolve?: (name: string) => string | undefined;
  run?: (file: string, args: string[], options: {
    stdio?: "inherit";
    encoding?: "utf8";
    timeout?: number;
  }) => { status: number | null; stdout?: string | Buffer | null; error?: Error };
  log?: (message: string) => void;
}

export function ensureSandboxDependencies(options?: SandboxDependencyOptions): void;
