import { describe, expect, it } from "vitest";

import {
  feishuTokenStatus,
  type StoredFeishuUserToken,
} from "../src/surfaces/feishu/oauth-token-store.js";

const token = (overrides: Partial<StoredFeishuUserToken> = {}): StoredFeishuUserToken => ({
  appId: "cli_0123456789abcdef",
  userOpenId: "ou_actor",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: 20_000_000,
  refreshExpiresAt: 30_000_000,
  scopes: ["drive:file:download"],
  grantedAt: 1_000_000,
  ...overrides,
});

describe("Feishu token status", () => {
  it("reports valid, refreshable, expired, and missing states without exposing tokens", () => {
    const now = 10_000_000;
    expect(feishuTokenStatus(null, now)).toBe("missing");
    expect(feishuTokenStatus(token({ expiresAt: now + 600_000, refreshExpiresAt: now + 1_000_000 }), now)).toBe("valid");
    expect(feishuTokenStatus(token({ expiresAt: now, refreshExpiresAt: now + 1_000_000 }), now)).toBe("refreshable");
    expect(feishuTokenStatus(token({ expiresAt: now, refreshExpiresAt: now }), now)).toBe("expired");
  });
});
