export function readCodexConfigFile(path: string, maximumBytes?: number): string;
export function createProviderFileAccess(environment: NodeJS.ProcessEnv): {
  read(path: string, maximumBytes?: number): string;
  write(path: string, content: string | Uint8Array): Promise<void>;
};
export function createProviderFileReader(environment: NodeJS.ProcessEnv): (path: string, maximumBytes?: number) => string;
