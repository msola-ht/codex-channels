export function readOpenAiSubscription(accountId: string | null, environment?: NodeJS.ProcessEnv): Promise<{
  activeUntil: number | null;
  lastChecked: number | null;
} | null>;
