export const maximumProviderCredentialBytes = 16_384;

/** Shared on-disk envelope; Provider owners validate their own API Key semantics. */
export function decodeProviderCredentialDocument(content) {
  const document = JSON.parse(content);
  if (document === null || typeof document !== "object" || Array.isArray(document)
    || Object.keys(document).length !== 4 || document.schemaVersion !== 1) return undefined;
  return document;
}

export function encodeProviderCredentialDocument(providerId, origin, apiKey) {
  return `${JSON.stringify({ schemaVersion: 1, providerId, origin, apiKey })}\n`;
}

export function providerCredentialMatchesIdentity(document, providerId, origin) {
  return document !== undefined && document.providerId === providerId && document.origin === origin;
}
