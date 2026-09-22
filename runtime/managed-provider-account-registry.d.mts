export interface BasicManagedProviderAccount {
  id: string;
  default: boolean;
}

export function validateBasicManagedProviderAccounts(
  value: unknown,
  options: {
    providerLabel: string;
    validateAccountId: (id: unknown) => string;
    credentialEnvironmentKey: (id: string) => string;
  },
): BasicManagedProviderAccount[];

export function assertManagedProviderDefaultAccount(
  accounts: readonly BasicManagedProviderAccount[],
  providerLabel: string,
  options?: {
    allowEmpty?: boolean;
    allowMissingDefault?: boolean;
  },
): void;
