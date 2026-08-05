export declare function apiProviderCredentialPath(
  credentialsDirectory: string,
  providerId: string,
): string;
export declare function readApiProviderKey(
  credentialsDirectory: string,
  providerId: string,
): string;
export declare function writeApiProviderKey(
  credentialsDirectory: string,
  providerId: string,
  apiKey: string,
): void;
export declare function removeApiProviderKey(
  credentialsDirectory: string,
  providerId: string,
): void;
