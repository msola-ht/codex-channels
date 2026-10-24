export function assertManagedAccountMode(mode: string, definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition, environment: NodeJS.ProcessEnv, loadPrimary?: (environment: NodeJS.ProcessEnv) => string): void;
export function snapshotManagedAccountFiles(paths: string[], definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition, environment: NodeJS.ProcessEnv): ReturnType<typeof import("./managed-provider-files.mjs").snapshotProviderFiles>;
export function managedAccountRevision(snapshots: ReturnType<typeof snapshotManagedAccountFiles>): string;
export function assertManagedAccountRevision(expected: string | undefined, actual: string): void;
export function managedAccountConfigurationEdit(input: { mode?: "switching" | "exclusive"; apiKey?: string; reconfigure?: boolean }, previous: import("../runtime/model-provider-runtime.mjs").ManagedModelProviderSettings | undefined, definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition, environment: NodeJS.ProcessEnv): {
  apiKey: string; mode: "switching" | "exclusive"; previousMode?: "switching" | "exclusive"; credentialAction: "preserve" | "replace"; willChange: boolean;
};
