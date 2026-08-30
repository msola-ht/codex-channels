import { describe, expect, it } from "vitest";

import { renderFeishuOAuthCard } from "../src/surfaces/feishu/oauth-card.js";

describe("Feishu OAuth card", () => {
  it("opens the device flow inside Feishu instead of exposing a plain external link", () => {
    const card = renderFeishuOAuthCard(
      "https://accounts.feishu.cn/device?code=abc",
      ["drive:file:download"],
      240,
    );
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({ schema: "2.0" });
    expect(serialized).toContain("https://applink.feishu.cn/client/web_url/open");
    expect(serialized).toContain("在飞书内授权");
    expect(serialized).not.toContain("app-secret");
  });

  it("refuses to wrap an authorization URL outside Feishu accounts", () => {
    expect(() => renderFeishuOAuthCard(
      "https://example.com/device?code=abc",
      ["drive:file:download", "offline_access"],
      240,
    )).toThrow("飞书 OAuth 授权地址无效");
  });

  it("refuses a nondefault port on the Feishu accounts host", () => {
    expect(() => renderFeishuOAuthCard(
      "https://accounts.feishu.cn:8443/device?code=abc",
      ["drive:file:download", "offline_access"],
      240,
    )).toThrow("飞书 OAuth 授权地址无效");
  });
});
