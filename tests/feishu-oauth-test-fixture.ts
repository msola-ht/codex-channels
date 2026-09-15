import type { StoredFeishuUserToken } from "../src/surfaces/feishu/oauth-token-store.js";

export function storedFeishuToken(
  overrides: Partial<StoredFeishuUserToken> = {},
): StoredFeishuUserToken {
  return {
    appId: "cli_0123456789abcdef",
    userOpenId: "ou_actor",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: 20_000_000,
    refreshExpiresAt: 30_000_000,
    scopes: ["drive:file:download"],
    grantedAt: 1_000_000,
    ...overrides,
  };
}
