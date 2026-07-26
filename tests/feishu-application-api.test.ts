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
            scopes: [
              { scope: "application:application:patch" },
            ],
            event: {
              subscribed_events: [
                "im.message.receive_v1",
                "application.bot.menu_v6",
              ],
            },
            callback_info: {
              subscribed_callbacks: ["card.action.trigger"],
            },
            mobile_default_ability: "bot",
            pc_default_ability: "bot",
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
      hasPatchScope: true,
      hasPendingVersion: false,
      messageEventConfigured: true,
      menuEventConfigured: true,
      cardCallbackConfigured: true,
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
      mobileDefaultAbility: "bot",
      pcDefaultAbility: "bot",
    });
  });

  it("fails closed before reading or publishing an existing pending version", async () => {
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
    await expect(api.configureAndPublish(snapshot)).rejects.toMatchObject({
      code: "pending-version",
    });
    expect(client.patchAbility).not.toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("preserves other menus and submits additive config before publishing", async () => {
    const client = createClient();
    const api = createApi(client);

    await expect(api.configureAndPublish({
      hasPatchScope: true,
      hasPendingVersion: false,
      messageEventConfigured: false,
      menuEventConfigured: false,
      cardCallbackConfigured: false,
      menuConfigured: false,
      botMenus: [{
        menu_id: "docs",
        sort: 4,
        default_name: "文档",
        redirect_link: {
          pc_url: "https://example.com/docs",
        },
        menu_content_type: 1,
      }],
      botMenuDisplayStrategy: 2,
      mobileDefaultAbility: "bot",
      pcDefaultAbility: "bot",
    })).resolves.toEqual({
      versionId: "oav_new",
      version: "1.2.3",
    });

    expect(client.patchAbility).toHaveBeenCalledWith(
      options.appId,
      {
        enable: true,
        bot_menu_enable: true,
        bot_menus: [
          {
            menu_id: "docs",
            sort: 4,
            default_name: "文档",
            redirect_link: {
              pc_url: "https://example.com/docs",
            },
            menu_content_type: 1,
          },
          {
            menu_id: "codexc_home",
            sort: 5,
            default_name: "Codex",
            event_key: "codexc_home",
            menu_content_type: 2,
          },
        ],
        bot_menu_display_strategy: 2,
      },
      undefined,
    );
    expect(client.patchConfig).toHaveBeenCalledBefore(client.publish);
    expect(client.publish).toHaveBeenCalledWith(
      options.appId,
      expect.objectContaining({
        mobile_default_ability: "bot",
        pc_default_ability: "bot",
      }),
      undefined,
    );
  });

  it("uses the SDK update authorization for the exact configured app", async () => {
    const client = createClient();
    const register = vi.fn(async (input: {
      onQRCodeReady(info: { url: string; expireIn: number }): void;
    }) => {
      input.onQRCodeReady({
        url: "https://applink.feishu.cn/client/mini_program/open?code=one",
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

    await api.authorizeConfiguration(
      new AbortController().signal,
      ready,
    );

    expect(ready).toHaveBeenCalledWith(
      "https://applink.feishu.cn/client/mini_program/open?code=one",
      600,
    );
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      appId: options.appId,
      addons: expect.objectContaining({
        preset: false,
      }),
    }));
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

    await expect(api.authorizeConfiguration(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toEqual(expect.objectContaining<
      Partial<FeishuApplicationSetupError>
    >({
      code: "authorization-invalid",
    }));
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

    await expect(api.authorizeConfiguration(
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

    await expect(api.authorizeConfiguration(
      new AbortController().signal,
      vi.fn(),
    )).rejects.toMatchObject({
      code: "authorization-invalid",
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
    patchAbility: vi.fn(async () => ({ code: 0 })),
    patchConfig: vi.fn(async () => ({ code: 0 })),
    publish: vi.fn(async () => ({
      code: 0,
      data: {
        version_id: "oav_new",
        version: "1.2.3",
      },
    })),
  };
}
