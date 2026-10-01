export function previewLegacyOpencodeGoRemoval(accountId?: string, options?: import("./managed-provider-account-runtime.mjs").ManagedAccountRuntimeOptions): Promise<{
  operation: "legacy-remove"; account: { id?: string; provider: string }; files: string[];
  effects: { stopsRunningAppServer: boolean; restoresInitialConfig: boolean; preservesPrivateBackup: true; historyThreadsBecomeUnavailable: true };
  activation: "restart-all";
}>;
export function removeLegacyOpencodeGoAccount(input?: { accountId?: string; confirmRemove?: boolean }, options?: import("./managed-provider-account-runtime.mjs").ManagedAccountRuntimeOptions): Promise<{
  action: "legacy-removed"; runtime: "stopped" | "not-running"; activation: "restart-all";
}>;
