export function createClineRelayCatalogBootstrap(environment: NodeJS.ProcessEnv, callbacks: {
  ready(): void | Promise<void>; failed(): void;
}): { ensure(status: "ready" | "missing" | "invalid"): void; close(): Promise<void> };
