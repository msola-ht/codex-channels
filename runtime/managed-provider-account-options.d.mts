export const opencodeGoReservedAccountIds: readonly string[];
export function newManagedAccountIdError(id: string, accounts: readonly { id: string }[], reservedIds?: readonly string[]): string | undefined;
export function managedAccountIdPresets(accounts: readonly { id: string }[]): { value: string; label: string }[];
