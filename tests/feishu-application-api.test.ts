import { describe, expect, it, vi } from "vitest";

import {
  FeishuApplicationHttpApi,
  FeishuApplicationSetupError,
} from "../src/surfaces/feishu/index.js";

const options = {
  appId: "cli_0123456789abcdef",
  appSecret: "secret",
};

describe("Feishu application management API", () => {
  it("inspects published menu and additive subscription state", async () => {
    const client = createClient({
      getApplication: async () => ({
        code: 0,
        data: {
          app: {
            app_id: options.appId,
            online_version_id: "oav_online",
            scopes: [],
            event: {
              subscribed_events: [
                "im.message.receive_v1",
                "application.bot.menu_v6",
              ],
            },
            callback_info: {
              subscribed_callbacks: ["card.action.trigger"],
            },
          },
        },
      }),
      getVersion: async () => ({
        code: 0,
        data: {
          app_version: {
            app_id: options.appId,
            ability: {
              bot: {
                bot_menu_enable: true,
                bot_menu_display_strategy: 2,
                bot_menus: [{
                  menu_id: "existing",
                  parent_menu_id: "",
                  sort: 1,
                  default_name: "Codex",
                  event_key: "codexc_home",
                  menu_content_type: 2,
                }],
              },
            },
          },
        },
      }),
    });
    const api = createApi(client);

    await expect(api.inspect()).resolves.toEqual({
      hasPendingVersion: false,
      messageEventConfigured: true,
      menuEventConfigured: true,
      cardCallbackConfigured: true,
      botMenuEnabled: true,
      menuConfigured: true,
      botMenus: [{
        menu_id: "existing",
        parent_menu_id: "",
        sort: 1,
        default_name: "Codex",
        event_key: "codexc_home",
        menu_content_type: 2,
      }],
      botMenuDisplayStrategy: 2,
    });
  });

  it("does not report a published menu node as enabled when its switch is off", async () => {
    const client = createClient({
      getApplication: async () => ({
        code: 0,
        data: {
          app: {
            app_id: options.appId,
            online_version_id: "oav_online",
            scopes: [],
          },
        },
      }),
      getVersion: async () => ({
        code: 0,
        data: {
          app_version: {
            app_id: options.appId,
            ability: {
              bot: {
                bot_menu_enable: false,
                bot_menus: [{
                  menu_id: "7351234567890123456",
                  sort: 0,
                  default_name: "Codex",
                  event_key: "codexc_home",
                  menu_content_type: 2,
                }],
              },
            },
          },
        },
      }),
    });

    await expect(createApi(client).inspect()).resolves.toMatchObject({
      botMenuEnabled: false,
      menuConfigured: false,
      botMenus: [expect.objectContaining({
        event_key: "codexc_home",
      })],
    });
  });

  it("reports an existing pending version without reading it", async () => {
    const client = createClient({
      getApplication: async () => ({
        code: 0,
        data: {
          app: {
            app_id: options.appId,
            unaudit_version_id: "oav_pending",
            scopes: [],
          },
        },
      }),
    });
    const api = createApi(client);
    const snapshot = await api.inspect();

    expect(snapshot.hasPendingVersion).toBe(true);
    expect(client.getVersion).not.toHaveBeenCalled();
  });

  it("uses the SDK update authorization for the exact configured app", async () => {
    const client = createClient();
    const register = vi.fn(async (input: {
      onQRCodeReady(info: { url: string; expireIn: number }): void;
    }) => {
      input.onQRCodeReady({
        url: "https://open.feishu.cn/oauth/v1/app/registration?code=one",
        expireIn: 600,
      });
      return {
        client_id: options.appId,
        client_secret: "ignored",
        user_info: {
          open_id: "ou_actor",
          tenant_brand: "feishu" as const,
        },
      };
    });
    const api = new FeishuApplicationHttpApi(options, {
      client,
      register: register as never,
    });
    const ready = vi.fn();

    await api.authorizeApplication(
      new AbortController().signal,
      ready,
    );

    expect(ready).toHaveBeenCalledWith(
      "https://open.feishu.cn/oauth/v1/app/registration?code=one",
      600,
    );
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      appId: options.appId,
      addons: expect.objectContaining({
        preset: false,
        scopes: {
          tenant: expect.not.arrayContaining([
            "application:application:patch",
          ]),
        },
      }),
    }));
  });

  it("rejects a lookalike application authorization Origin", async () => {
    const api = new FeishuApplicationHttpApi(options, {
      client: createClient(),
      register: (async (input: {
        onQRCodeReady(info: { url: string; expireIn: number }): void;
      }) => {
        input.onQRCodeReady({
          url: "https://open.feishu.cn.example.com/oauth?code=secret",
          expireIn: 600,
        });
        throw new Error("unreachable");
      }) as never,
    });

    await expect(api.authorizeApplication(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toMatchObject({
      code: "authorization-invalid",
    });
  });

  it("rejects a configuration authorization for another app", async () => {
    const api = new FeishuApplicationHttpApi(options, {
      client: createClient(),
      register: (async () => ({
        client_id: "cli_ffffffffffffffff",
        client_secret: "ignored",
        user_info: {
          open_id: "ou_actor",
          tenant_brand: "feishu",
        },
      })) as never,
    });

    await expect(api.authorizeApplication(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toEqual(expect.objectContaining<
      Partial<FeishuApplicationSetupError>
    >({
      code: "authorization-invalid",
      authorizationFailure: "app-mismatch",
    }));
  });

  it("classifies a denied SDK registration without exposing its response", async () => {
    const api = new FeishuApplicationHttpApi(options, {
      client: createClient(),
      register: (async () => {
        throw Object.assign(new Error("sensitive response"), {
          code: "access_denied",
          description: "sensitive response",
          response: {
            status: 403,
            data: "sensitive response",
          },
        });
      }) as never,
    });

    await expect(api.authorizeApplication(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toMatchObject({
      code: "authorization-invalid",
      authorizationFailure: "access-denied",
      authorizationDiagnostic: {
        errorName: "Error",
        errorCode: "access_denied",
        httpStatus: 403,
      },
      message: "飞书应用授权失败",
    });
  });

  it("drops unsafe registration diagnostic fields", async () => {
    const api = new FeishuApplicationHttpApi(options, {
      client: createClient(),
      register: (async () => {
        throw Object.assign(new Error("sensitive response"), {
          name: "AxiosError",
          code: "ERR_BAD_REQUEST\nsecret",
          response: {
            status: 400,
            data: "sensitive response",
          },
        });
      }) as never,
    });

    await expect(api.authorizeApplication(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toMatchObject({
      authorizationFailure: "registration-failed",
      authorizationDiagnostic: {
        errorName: "AxiosError",
        httpStatus: 400,
      },
    });
  });

  it("does not compare app-scoped registration Open ID with the card actor", async () => {
    const api = new FeishuApplicationHttpApi(options, {
      client: createClient(),
      register: (async () => ({
        client_id: options.appId,
        client_secret: "ignored",
        user_info: {
          open_id: "ou_other",
          tenant_brand: "feishu",
        },
      })) as never,
    });

    await expect(api.authorizeApplication(
      new AbortController().signal,
      vi.fn(),
    )).resolves.toBeUndefined();
  });

  it("rejects configuration authorization completed in an unsupported Lark tenant", async () => {
    const api = new FeishuApplicationHttpApi(options, {
      client: createClient(),
      register: (async () => ({
        client_id: options.appId,
        client_secret: "ignored",
        user_info: {
          open_id: "ou_actor",
          tenant_brand: "lark",
        },
      })) as never,
    });

    await expect(api.authorizeApplication(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toMatchObject({
      code: "authorization-invalid",
      authorizationFailure: "unsupported-tenant",
    });
  });
});

function createApi(client: ReturnType<typeof createClient>) {
  return new FeishuApplicationHttpApi(options, {
    client,
    register: vi.fn() as never,
  });
}

function createClient(overrides: Partial<{
  getApplication: () => Promise<unknown>;
  getVersion: () => Promise<unknown>;
}> = {}) {
  return {
    getApplication: vi.fn(overrides.getApplication ?? (async () => ({}))),
    getVersion: vi.fn(overrides.getVersion ?? (async () => ({}))),
  };
}
