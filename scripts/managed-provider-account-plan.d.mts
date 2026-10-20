export function assertManagedAccountMode(mode: string, definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition, environment: NodeJS.ProcessEnv, loadPrimary?: (environment: NodeJS.ProcessEnv) => string): void;
export function snapshotManagedAccountFiles(paths: string[], definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition, environment: NodeJS.ProcessEnv): ReturnType<typeof import("./managed-provider-files.mjs").snapshotProviderFiles>;
export function managedAccountRevision(snapshots: ReturnType<typeof snapshotManagedAccountFiles>): string;
export function assertManagedAccountRevision(expected: string | undefined, actual: string): void;
