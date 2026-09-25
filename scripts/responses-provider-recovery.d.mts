export function recoverResponsesProviderCatalog(id: string, action: "keep" | "rollback", environment?: NodeJS.ProcessEnv): Promise<{providerId: string; action: "keep" | "rollback"}>;
