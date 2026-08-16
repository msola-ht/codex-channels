import { describe, expect, it, vi } from "vitest";

import {
  abortableSleep,
  FeishuOAuthHttpClient,
} from "../src/surfaces/feishu/oauth-device-flow.js";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

describe("Feishu OAuth HTTP client", () => {
  it("cancels sleep immediately when the authorization lifecycle is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortableSleep(60_000, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("reads only user-capable application scopes", async () => {
    const client = createClient({
      listGrantedUserScopes: async () => ({
        code: 0,
        data: {
          app: {
            scopes: [
              { scope: "drive:file:download", token_types: ["user"] },
              { scope: "im:message:send_as_bot", token_types: ["tenant"] },
              { scope: "shared:scope" },
              { scope: "drive:file:download", token_types: ["user"] },
              { scope: "", token_types: ["user"] },
            ],
          },
        },
      }),
    });

    await expect(client.listGrantedUserScopes(
      new AbortController().signal,
    )).resolves.toEqual([
      "drive:file:download",
      "shared:scope",
    ]);
  });

  it("applies the user scope limit after filtering tenant-only entries", async () => {
    const tenantScopes = Array.from(
      { length: 100 },
      (_, index) => ({
        scope: `tenant:${index}`,
        token_types: ["tenant"],
      }),
    );
    const client = createClient({
      listGrantedUserScopes: async () => ({
        code: 0,
        data: {
          app: {
            scopes: [
              ...tenantScopes,
              {
                scope: "drive:file:download",
                token_types: ["user"],
              },
            ],
          },
        },
      }),
    });

    await expect(client.listGrantedUserScopes(
      new AbortController().signal,
    )).resolves.toEqual(["drive:file:download"]);
  });

  it("accepts more than one hundred granted user scopes", async () => {
    const client = createClient({
      listGrantedUserScopes: async () => ({
        code: 0,
        data: {
          app: {
            scopes: Array.from(
              { length: 137 },
              (_, index) => ({
                scope: `user:${index}`,
                token_types: ["user"],
              }),
            ),
          },
        },
      }),
    });

    await expect(client.listGrantedUserScopes(
      new AbortController().signal,
    )).resolves.toHaveLength(137);
  });

  it("fails closed on malformed application scope responses", async () => {
    const missingCode = createClient({
      listGrantedUserScopes: async () => ({
        data: {
          app: {
            scopes: [],
          },
        },
      }),
    });
    const malformedTokenTypes = createClient({
      listGrantedUserScopes: async () => ({
        code: 0,
        data: {
          app: {
            scopes: [{
              scope: "drive:file:download",
              token_types: "user",
            }],
          },
        },
      }),
    });
    const oversizedScope = createClient({
      listGrantedUserScopes: async () => ({
        code: 0,
        data: {
          app: {
            scopes: [{
              scope: `drive:${"x".repeat(200)}`,
              token_types: ["user"],
            }],
          },
        },
      }),
    });
    const excessiveApplicationScopes = createClient({
      listGrantedUserScopes: async () => ({
        code: 0,
        data: {
          app: {
            scopes: Array.from(
              { length: 1_001 },
              (_, index) => ({
                scope: `user:${index}`,
                token_types: ["user"],
              }),
            ),
          },
        },
      }),
    });

    await expect(missingCode.listGrantedUserScopes(
      new AbortController().signal,
    )).rejects.toThrow("无法读取飞书应用权限");
    await expect(malformedTokenTypes.listGrantedUserScopes(
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
    await expect(oversizedScope.listGrantedUserScopes(
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
    await expect(excessiveApplicationScopes.listGrantedUserScopes(
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
  });

  it("requests Device Flow with confidential client authentication and offline access", async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({
      device_code: "device-secret",
      verification_uri_complete: "https://accounts.feishu.cn/device?code=abc",
      expires_in: 240,
      interval: 5,
    }));
    const client = createClient({ fetch });

    await expect(client.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).resolves.toEqual({
      deviceCode: "device-secret",
      verificationUriComplete:
        "https://accounts.feishu.cn/device?code=abc",
      expiresInSeconds: 240,
      intervalSeconds: 5,
      scopes: ["drive:file:download", "offline_access"],
    });

    const request = fetch.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://accounts.feishu.cn/oauth/v1/device_authorization",
    );
    const options = request?.[1] as RequestInit;
    expect(String(options.body)).toContain(
      "scope=drive%3Afile%3Adownload+offline_access",
    );
    expect((options.headers as Record<string, string>).Authorization)
      .toMatch(/^Basic /u);
  });

  it("supports one hundred application scopes plus offline access", async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({
      device_code: "device-secret",
      verification_uri_complete: "https://accounts.feishu.cn/device?code=abc",
      expires_in: 240,
      interval: 5,
    }));
    const client = createClient({ fetch });
    const scopes = Array.from(
      { length: 100 },
      (_, index) => `scope:${index}`,
    );

    await expect(client.requestDeviceAuthorization(
      scopes,
      new AbortController().signal,
    )).resolves.toMatchObject({
      scopes: [...scopes, "offline_access"],
    });
  });

  it("rejects untrusted authorization URLs and unbounded timing values", async () => {
    const untrustedUrl = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        device_code: "device-secret",
        verification_uri_complete: "https://example.com/device?code=abc",
        expires_in: 240,
        interval: 5,
      })),
    });
    const excessiveInterval = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        device_code: "device-secret",
        verification_uri_complete:
          "https://accounts.feishu.cn/device?code=abc",
        expires_in: 240,
        interval: 3_600,
      })),
    });

    await expect(untrustedUrl.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
    await expect(excessiveInterval.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
  });

  it("requires a complete device authorization URL on the exact Feishu accounts origin", async () => {
    const incompleteUrl = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        device_code: "device-secret",
        verification_uri: "https://accounts.feishu.cn/device",
        user_code: "ABCD-EFGH",
        expires_in: 240,
        interval: 5,
      })),
    });
    const nondefaultPort = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        device_code: "device-secret",
        verification_uri_complete:
          "https://accounts.feishu.cn:8443/device?code=abc",
        expires_in: 240,
        interval: 5,
      })),
    });

    await expect(incompleteUrl.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
    await expect(nondefaultPort.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
  });

  it("uses official timing defaults only when optional fields are absent", async () => {
    const client = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        device_code: "device-secret",
        verification_uri_complete:
          "https://accounts.feishu.cn/device?code=abc",
      })),
    });

    await expect(client.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).resolves.toMatchObject({
      expiresInSeconds: 240,
      intervalSeconds: 5,
    });
  });

  it("rejects oversized device and token response values", async () => {
    const deviceClient = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        device_code: "x".repeat(5_000),
        verification_uri_complete:
          "https://accounts.feishu.cn/device?code=abc",
        expires_in: 240,
        interval: 5,
      })),
    });
    const tokenClient = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({
        access_token: "x".repeat(20_000),
        expires_in: 7_200,
        scope: "offline_access",
      })),
      sleep: vi.fn(async () => {}),
    });

    await expect(deviceClient.requestDeviceAuthorization(
      ["drive:file:download"],
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
    await expect(tokenClient.pollDeviceToken({
      deviceCode: "device-secret",
      verificationUriComplete: "https://accounts.feishu.cn/device",
      expiresInSeconds: 240,
      intervalSeconds: 5,
      scopes: ["offline_access"],
    }, new AbortController().signal))
      .rejects.toThrow("飞书 OAuth 响应格式无效");
  });

  it("polls pending and slow-down responses before returning a sanitized token result", async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({
        error: "authorization_pending",
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: "slow_down",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 7_200,
        refresh_token_expires_in: 604_800,
        scope: "drive:file:download offline_access",
      }));
    const sleep = vi.fn(async () => {});
    const client = createClient({ fetch, sleep });

    await expect(client.pollDeviceToken({
      deviceCode: "device-secret",
      verificationUriComplete: "https://accounts.feishu.cn/device",
      expiresInSeconds: 240,
      intervalSeconds: 5,
      scopes: ["drive:file:download", "offline_access"],
    }, new AbortController().signal)).resolves.toEqual({
      status: "authorized",
      token: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresInSeconds: 7_200,
        refreshExpiresInSeconds: 604_800,
        scopes: ["drive:file:download", "offline_access"],
      },
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(3, 10_000, expect.any(AbortSignal));
  });

  it("accepts the full granted scope list returned by the token endpoint", async () => {
    const grantedScopes = Array.from(
      { length: 137 },
      (_, index) => `scope:${index}`,
    );
    const fetch = vi.fn<Fetch>(async () => jsonResponse({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 7_200,
      refresh_token_expires_in: 604_800,
      scope: grantedScopes.join(" "),
    }));
    const client = createClient({ fetch });

    await expect(client.pollDeviceToken({
      deviceCode: "device-secret",
      verificationUriComplete: "https://accounts.feishu.cn/device",
      expiresInSeconds: 240,
      intervalSeconds: 5,
      scopes: ["drive:file:download", "offline_access"],
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "authorized",
      token: {
        scopes: grantedScopes,
      },
    });
  });

  it("verifies the authorized account without returning any other profile data", async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({
      code: 0,
      data: {
        open_id: "ou_actor",
        name: "private name",
      },
    }));
    const client = createClient({ fetch });

    await expect(client.readAuthorizedUser(
      "access-secret",
      new AbortController().signal,
    ))
      .resolves.toBe("ou_actor");
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-secret");
  });

  it("refreshes a user token with bounded rotation fields", async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({
      access_token: "access-refreshed",
      refresh_token: "refresh-rotated",
      expires_in: 7_200,
      refresh_token_expires_in: 604_800,
      open_id: "ou_actor",
    }));
    const client = createClient({ fetch });

    await expect(client.refreshUserToken(
      "refresh-secret",
      new AbortController().signal,
    )).resolves.toEqual({
      accessToken: "access-refreshed",
      refreshToken: "refresh-rotated",
      expiresInSeconds: 7_200,
      refreshExpiresInSeconds: 604_800,
      openId: "ou_actor",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url))
      .toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token");
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    expect(String(init?.body)).toContain("refresh_token=refresh-secret");
  });

  it("retries once when the refresh endpoint reports a transient server error", async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 20_050 }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: "access-refreshed",
        expires_in: 7_200,
      }));
    const client = createClient({ fetch });

    await expect(client.refreshUserToken(
      "refresh-secret",
      new AbortController().signal,
    )).resolves.toMatchObject({
      accessToken: "access-refreshed",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("classifies terminal refresh errors without clearing anything", async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({ code: 20_037 }));
    const client = createClient({ fetch });

    await expect(client.refreshUserToken(
      "refresh-secret",
      new AbortController().signal,
    )).rejects.toMatchObject({
      name: "FeishuOAuthRefreshError",
      terminal: true,
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects refresh responses without an access token", async () => {
    const client = createClient({
      fetch: vi.fn<Fetch>(async () => jsonResponse({ code: 0 })),
    });

    await expect(client.refreshUserToken(
      "refresh-secret",
      new AbortController().signal,
    )).rejects.toThrow("飞书 OAuth 响应格式无效");
  });
});

function createClient({
  fetch = vi.fn<Fetch>(async () => jsonResponse({})),
  sleep = vi.fn(async () => {}),
  listGrantedUserScopes = async () => ({
    code: 0,
    data: {
      app: {
        scopes: [],
      },
    },
  }),
}: {
  fetch?: Fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  listGrantedUserScopes?: (signal: AbortSignal) => Promise<unknown>;
} = {}): FeishuOAuthHttpClient {
  return new FeishuOAuthHttpClient(
    "cli_0123456789abcdef",
    "app-secret",
    {
      fetch,
      sleep,
      listGrantedUserScopes,
    },
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
