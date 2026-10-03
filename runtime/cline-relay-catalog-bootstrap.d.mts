export function createClineRelayCatalogBootstrap(environment: NodeJS.ProcessEnv, callbacks: {
  ready(): void | Promise<void>; failed(): void;
}): { ensure(): void; close(): Promise<void> };
