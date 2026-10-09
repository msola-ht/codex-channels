export function isolateProviderCredential(
  provider: string,
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
  credential?: { environmentKey: string; apiKey: string },
): { arguments: string[]; childEnvironment: NodeJS.ProcessEnv };
