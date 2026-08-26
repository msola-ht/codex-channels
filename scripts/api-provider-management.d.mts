export interface ApiProviderSummary {
  id: string;
  name: string;
  protocol: "responses";
  endpoint: string;
  hasApiKey: boolean;
}

export function listApiProviders(environment?: NodeJS.ProcessEnv): {
  configPath: string;
  providers: ApiProviderSummary[];
};

export function saveApiProvider(
  input: {
    operation: "create" | "update";
    id: string;
    name: string;
    endpoint: string;
    apiKey?: string;
  },
  options?: {
    environment?: NodeJS.ProcessEnv;
    writeConfig?: (configPath: string, document: unknown) => void;
  },
): {
  action: "created" | "updated";
  provider: ApiProviderSummary;
  configPath: string;
  activation: "restart-gateway";
};

export function deleteApiProvider(
  id: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    writeConfig?: (configPath: string, document: unknown) => void;
  },
): {
  action: "removed";
  provider: string;
  configPath: string;
  activation: "restart-gateway";
};

export function validateApiProviderId(value: unknown): string | undefined;
export function validateApiProviderName(value: unknown): string | undefined;
export function validateApiProviderEndpoint(value: unknown): string | undefined;
