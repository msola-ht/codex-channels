export interface ManagedModelProviderRuntime {
  provider: "deepseek";
  name: "deepseek";
  baseUrl: "https://api.deepseek.com/";
  wireApi: "responses";
  childEnvironmentKey: "CODEX_CONNECT_DEEPSEEK_API_KEY";
  apiKey: string;
}

export function loadManagedModelProvider(
  environment?: NodeJS.ProcessEnv,
): ManagedModelProviderRuntime | undefined;

export function loadDeepseekAccountCredential(
  environment?: NodeJS.ProcessEnv,
): string;
