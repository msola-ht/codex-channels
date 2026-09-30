export function startModelRelayService(configPath: string, environment?: NodeJS.ProcessEnv): Promise<{
  close(): Promise<void>;
  refresh(): Promise<void>;
  status(): { enabled: boolean; listening: boolean };
}>;
