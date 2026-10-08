export class ProviderModelGuard {
  constructor(path: string, isModelValid: (model: unknown) => boolean, options?: {
    parseCatalog?: (content: string) => unknown;
    blockedPaths?: readonly string[];
  });
  isEnabled(model: string, signal?: AbortSignal): Promise<boolean>;
  modelCapabilities(model: string, signal?: AbortSignal): Promise<{ reasoningEfforts: string[] } | undefined>;
  close(): Promise<void>;
}
