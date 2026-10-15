export function startModelRelayService(configPath: string, environment?: NodeJS.ProcessEnv, options?: { signal?: AbortSignal }): Promise<{
  close(): Promise<void>;
  refresh(): Promise<void>;
  status(): { enabled: boolean; listening: boolean };
}>;
