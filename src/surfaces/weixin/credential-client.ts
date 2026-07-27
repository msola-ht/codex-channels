import type { WeixinCredentialStore } from "./credential-store.js";
import {
  createWeixinProtocolClient,
  type WeixinProtocolClient,
} from "./protocol-client.js";

export interface CreateCredentialBackedWeixinClientOptions {
  accountId: string;
  credentialStore: WeixinCredentialStore;
  createClient?: typeof createWeixinProtocolClient;
}

export function createCredentialBackedWeixinClient(
  options: CreateCredentialBackedWeixinClientOptions,
): WeixinProtocolClient {
  let clientTask: Promise<WeixinProtocolClient> | undefined;
  const client = (): Promise<WeixinProtocolClient> => {
    clientTask ??= options.credentialStore.get(options.accountId)
      .then((credential) => {
        if (credential === null) {
          throw new Error("微信加密凭据不存在");
        }
        return (options.createClient ?? createWeixinProtocolClient)({
          accountId: credential.accountId,
          baseUrl: credential.baseUrl,
          botToken: credential.botToken,
        });
      });
    return clientTask;
  };
  return {
    async getUpdates(cursor, signal) {
      return (await client()).getUpdates(cursor, signal);
    },
    async sendText(input, signal) {
      return (await client()).sendText(input, signal);
    },
  };
}
