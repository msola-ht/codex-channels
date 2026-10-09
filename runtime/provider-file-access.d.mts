export function readCodexConfigFile(path: string, maximumBytes?: number): string;
export function assertCodexConfigHasNoPlaintextCredentials(content: string | Uint8Array): void;
export function assertProviderHasNoPlaintextCredentials(provider: unknown): void;
export function createProviderFileAccess(environment: NodeJS.ProcessEnv): {
  isMainConfig(path: string): boolean;
  read(path: string, maximumBytes?: number): string;
  write(path: string, content: string | Uint8Array): Promise<void>;
};
export function createProviderFileReader(environment: NodeJS.ProcessEnv): (path: string, maximumBytes?: number) => string;
