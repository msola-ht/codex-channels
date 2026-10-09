export const maximumProviderCredentialBytes: 16384;
export type ProviderCredentialDocument = {
  schemaVersion: 1;
  providerId: unknown;
  origin: unknown;
  apiKey: unknown;
};
export function decodeProviderCredentialDocument(content: string): ProviderCredentialDocument | undefined;
export function encodeProviderCredentialDocument(providerId: string, origin: string, apiKey: string): string;
export function providerCredentialMatchesIdentity(document: ProviderCredentialDocument | undefined, providerId: string, origin: string): boolean;
