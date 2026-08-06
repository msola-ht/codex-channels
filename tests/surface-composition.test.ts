import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationUseCases } from "../src/application/index.js";
import type { InteractionPort } from "../src/approval/index.js";
import {
  createFeishuRuntimeModule,
  createSurfaceModules,
  createTelegramRuntimeModule,
  createWeixinRuntimeModule,
  selectFeishuProxyUrl,
  weixinSurfacePlugin,
  type FeishuRuntimeAdapter,
  type TelegramRuntimeAdapter,
  type WeixinRuntimeAdapter,
} from "../src/bootstrap/surface-composition.js";
import {
  composeBuiltInSurfacePlugins,
  type BuiltInSurfacePlugin,
  type SurfaceRuntimeModule,
} from "../src/bootstrap/surface-plugin.js";
import type { GatewayConfig } from "../src/config/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";
import { EncryptedFileWeixinCredentialStore } from "../src/surfaces/weixin/index.js";

const interactions = {} as InteractionPort;
const temporaryDirectories: string[] = [];
const linuxIt = process.platform === "linux" ? it : it.skip;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Telegram Surface runtime composition", () => {
  it("hot reloads authorization and notification recipients", () => {
    const recipientSnapshots: number[][] = [];
    const replaceAccess = vi.fn();
    const module = createTelegramRuntimeModule(
      adapter(recipientSnapshots),
      { replace: replaceAccess },
      new Set([123]),
    );
    const next = config({ telegramAllowedUserIds: new Set([456, 789]) });

    module.applyHotReload(next, [{
      code: "surface.telegram.allowed-users",
      scope: "telegram",
    }]);

    expect(replaceAccess).toHaveBeenCalledWith(next.telegramAllowedUserIds);
    expect(recipientSnapshots).toEqual([[456, 789]]);
  });

  it("uses the old/new recipient intersection for restart notice and then restores current recipients", () => {
    const recipientSnapshots: number[][] = [];
    const module = createTelegramRuntimeModule(
      adapter(recipientSnapshots),
      { replace: vi.fn() },
      new Set([123, 456]),
    );
    const hotReloaded = config({ telegramAllowedUserIds: new Set([456, 789]) });
    module.applyHotReload(hotReloaded, [{
      code: "surface.telegram.allowed-users",
      scope: "telegram",
    }]);
    recipientSnapshots.length = 0;

    const restore = module.prepareRestartNotification(
      config({ telegramAllowedUserIds: new Set([789, 999]) }),
    );
    restore();

    expect(recipientSnapshots).toEqual([
      [789],
      [456, 789],
    ]);
  });

  it("ignores unrelated hot reload changes", () => {
    const recipientSnapshots: number[][] = [];
    const replaceAccess = vi.fn();
    const module = createTelegramRuntimeModule(
      adapter(recipientSnapshots),
      { replace: replaceAccess },
      new Set([123]),
    );

    module.applyHotReload(config(), [{
      code: "workspace.registry",
      scope: "global",
    }]);

    expect(replaceAccess).not.toHaveBeenCalled();
    expect(recipientSnapshots).toEqual([]);
  });
});

describe("configured Surface composition", () => {
  it("registers optional Surfaces only when their runtime config is enabled", () => {
    const disabled = createSurfaceModules(options(config()));
    const enabled = createSurfaceModules(options(config({
      feishu: {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
        allowedOpenIds: new Set(["ou_actor"]),
      },
      weixin: {
        accountId: "bot-fixture@im.bot",
        allowedUserIds: new Set(["actor-fixture@im.wechat"]),
      },
    })));

    expect(disabled.map((module) => module.adapter.surface)).toEqual([
      "telegram",
    ]);
    expect(enabled.map((module) => module.adapter.surface)).toEqual([
      "telegram",
      "feishu",
      "weixin",
    ]);
  });

  it("removes revoked Weixin bindings while composing a restarted Surface", () => {
    const bindings = new MemoryBindingStore();
    const accountId = "bot-fixture@im.bot";
    const allowed = {
      surface: "weixin",
      accountId,
      conversationId: "allowed@im.wechat",
    } as const;
    const revoked = {
      surface: "weixin",
      accountId,
      conversationId: "revoked@im.wechat",
    } as const;
    for (const [target, actorId, threadId] of [
      [allowed, "allowed@im.wechat", "thread-allowed"],
      [revoked, "revoked@im.wechat", "thread-revoked"],
    ] as const) {
      bindings.bind({
        target,
        workspaceId: "main",
        threadId,
        sessionId: `session-${threadId}`,
      });
      bindings.rememberActor(target, actorId);
    }

    createSurfaceModules(options(config({
      weixin: {
        accountId,
        allowedUserIds: new Set(["allowed@im.wechat"]),
      },
    }), bindings));

    expect(bindings.getByThread("thread-allowed")).toBeDefined();
    expect(bindings.getByThread("thread-revoked")).toBeUndefined();
  });

  linuxIt("loads Linux Weixin credentials from the config directory independently of the database path", async () => {
    const root = mkdtempSync(join(tmpdir(), "weixin-composition-"));
    temporaryDirectories.push(root);
    const credentialsDirectory = join(root, "credentials");
    const accountId = "bot-fixture@im.bot";
    await new EncryptedFileWeixinCredentialStore(
      join(credentialsDirectory, "weixin"),
    ).set({
      version: 1,
      accountId,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-secret",
      grantedAt: 1,
    });
    const runtimeConfig = config({
      credentialsDirectory,
      stateDatabasePath: join(root, "separate-state", "gateway.sqlite3"),
      weixin: {
        accountId,
        allowedUserIds: new Set(["actor-fixture@im.wechat"]),
      },
    });
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (
        url.endsWith("/msg/notifystart")
        || url.endsWith("/msg/notifystop")
      ) {
        return Promise.resolve(
          new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const context = options(runtimeConfig);
    const [module] = createSurfaceModules(context, [weixinSurfacePlugin]);

    try {
      await module?.adapter.start();
      await vi.waitFor(() => {
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });
      expect(fetchImpl.mock.calls.map(([input]) => String(input)).sort())
        .toEqual([
          "https://ilinkai.weixin.qq.com/ilink/bot/getupdates",
          "https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystart",
        ]);
      expect(context.onFatal).not.toHaveBeenCalled();
    } finally {
      await module?.adapter.stop();
    }
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystop",
    );
  });

  it("selects the shared HTTPS proxy unless NO_PROXY covers the Feishu host", () => {
    const proxy = {
      http: "http://127.0.0.1:7890",
      https: "http://127.0.0.1:7891",
      no: "localhost,.internal.example",
    };

    expect(selectFeishuProxyUrl(proxy, "open.feishu.cn")).toBe(
      "http://127.0.0.1:7891/",
    );
    expect(selectFeishuProxyUrl(
      { ...proxy, no: "localhost,.feishu.cn" },
      "open.feishu.cn",
    )).toBeUndefined();
  });

  it("fails closed instead of bypassing an invalid or unsupported Feishu proxy", () => {
    expect(() => selectFeishuProxyUrl(
      { all: "socks5://127.0.0.1:7890" },
      "open.feishu.cn",
    )).toThrow("HTTP(S) 客户端代理只支持 http:// 或 https://");
    expect(() => selectFeishuProxyUrl(
      { https: "not a proxy URL" },
      "open.feishu.cn",
    )).toThrow("HTTP(S) 代理不是有效 URL");
    expect(selectFeishuProxyUrl(
      {
        all: "socks5://127.0.0.1:7890",
        no: ".feishu.cn",
      },
      "open.feishu.cn",
    )).toBeUndefined();
  });
});

describe("built-in Surface plugin host", () => {
  it("keeps explicit plugin order and accepts zero or multiple account modules", () => {
    const plugins: BuiltInSurfacePlugin[] = [
      {
        id: "telegram",
        create: () => [runtimeModule("telegram", "default")],
      },
      {
        id: "disabled",
        create: () => [],
      },
      {
        id: "wechat",
        create: () => [
          runtimeModule("wechat", "personal"),
          runtimeModule("wechat", "work"),
        ],
      },
    ];

    expect(composeBuiltInSurfacePlugins(plugins, options(config()))
      .map((module) => `${module.adapter.surface}/${module.adapter.accountId}`))
      .toEqual([
        "telegram/default",
        "wechat/personal",
        "wechat/work",
      ]);
  });

  it("rejects duplicate plugin IDs", () => {
    const plugins: BuiltInSurfacePlugin[] = [
      { id: "telegram", create: () => [] },
      { id: "telegram", create: () => [] },
    ];

    expect(() => composeBuiltInSurfacePlugins(plugins, options(config())))
      .toThrow("内置 Surface 插件 ID 重复：telegram");
  });

  it("rejects modules returned for another Surface", () => {
    const plugins: BuiltInSurfacePlugin[] = [{
      id: "wechat",
      create: () => [runtimeModule("telegram", "default")],
    }];

    expect(() => composeBuiltInSurfacePlugins(plugins, options(config())))
      .toThrow("内置 Surface 插件 wechat 返回了其他 Surface：telegram");
  });

  it("rejects duplicate Surface accounts returned by one plugin", () => {
    const duplicatedAccountPlugin: BuiltInSurfacePlugin = {
      id: "wechat",
      create: () => [
        runtimeModule("wechat", "personal"),
        runtimeModule("wechat", "personal"),
      ],
    };

    expect(() => composeBuiltInSurfacePlugins(
      [duplicatedAccountPlugin],
      options(config()),
    )).toThrow("Surface 账号重复：wechat/personal");
  });
});

describe("Feishu Surface runtime composition", () => {
  it("hot reloads authorization and removes bindings for revoked actors", () => {
    const bindings = new MemoryBindingStore();
    const allowed = {
      surface: "feishu",
      accountId: "cli_0123456789abcdef",
      conversationId: "oc_allowed",
    } as const;
    const revoked = {
      surface: "feishu",
      accountId: "cli_0123456789abcdef",
      conversationId: "oc_revoked",
    } as const;
    for (const [target, actorId, threadId] of [
      [allowed, "ou_actor", "thread-allowed"],
      [revoked, "ou_revoked", "thread-revoked"],
    ] as const) {
      bindings.bind({
        target,
        workspaceId: "main",
        threadId,
        sessionId: `session-${threadId}`,
      });
      bindings.rememberActor(target, actorId);
    }
    const replaceAccess = vi.fn();
    const module = createFeishuRuntimeModule(
      feishuAdapter(),
      { replace: replaceAccess },
      bindings,
      pino({ level: "silent" }),
    );
    const next = config({
      feishu: {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
        allowedOpenIds: new Set(["ou_actor"]),
      },
    });

    module.applyHotReload(next, [{
      code: "surface.feishu.allowed-users",
      scope: "feishu",
    }]);

    expect(replaceAccess).toHaveBeenCalledWith(next.feishu?.allowedOpenIds);
    expect(bindings.getByThread("thread-allowed")).toBeDefined();
    expect(bindings.getByThread("thread-revoked")).toBeUndefined();
  });
});

describe("Weixin Surface runtime composition", () => {
  it("hot reloads added authorization without changing bindings", () => {
    const accountId = "bot-fixture@im.bot";
    const replaceAccess = vi.fn();
    const module = createWeixinRuntimeModule(
      weixinAdapter(),
      { replace: replaceAccess },
    );
    const next = config({
      weixin: {
        accountId,
        allowedUserIds: new Set([
          "allowed@im.wechat",
          "new@im.wechat",
        ]),
      },
    });

    module.applyHotReload(next, [{
      code: "surface.weixin.allowed-users",
      scope: "weixin",
    }]);

    expect(replaceAccess).toHaveBeenCalledWith(next.weixin?.allowedUserIds);
  });
});

function adapter(recipientSnapshots: number[][]): TelegramRuntimeAdapter {
  return {
    surface: "telegram",
    accountId: "default",
    interactions,
    output: {
      handle() {},
    },
    async start() {},
    async stop() {},
    async deliverConfigurationChange() {},
    replaceNotificationRecipients(recipients) {
      recipientSnapshots.push([...recipients]);
    },
  };
}

function feishuAdapter(): FeishuRuntimeAdapter {
  return {
    surface: "feishu",
    accountId: "cli_0123456789abcdef",
    interactions,
    output: {
      handle() {},
    },
    async start() {},
    async stop() {},
    async deliverConfigurationChange() {},
  };
}

function weixinAdapter(): WeixinRuntimeAdapter {
  return {
    surface: "weixin",
    accountId: "bot-fixture@im.bot",
    interactions,
    output: {
      handle() {},
    },
    async start() {},
    async stop() {},
    async deliverConfigurationChange() {},
  };
}

function runtimeModule(
  surface: string,
  accountId: string,
): SurfaceRuntimeModule {
  return {
    adapter: {
      surface,
      accountId,
      interactions,
      output: { handle() {} },
      async start() {},
      async stop() {},
      async deliverConfigurationChange() {},
    },
    applyHotReload() {},
    prepareRestartNotification() {
      return () => {};
    },
  };
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "token",
    telegramAllowedUserIds: new Set([123]),
    telegramMessageFormat: "html",
    codexBinary: "codex",
    networkProxy: {},
    workspaces: [{ id: "main", name: "Main", cwd: "/workspace" }],
    defaultWorkspaceId: "main",
    codexSocketPath: "/tmp/codex.sock",
    codexSandbox: "workspace-write",
    operationUpdateDisplay: "full",
    planUpdatesEnabled: false,
    priceCurrency: "cny",
    apiProviders: [],
    vision: { mode: "disabled" },
    credentialsDirectory: "/tmp/credentials",
    stateDatabasePath: "/tmp/gateway.sqlite3",
    approvalTimeoutMs: 300_000,
    logLevel: "info",
    ...overrides,
  };
}

function options(
  runtimeConfig: GatewayConfig,
  bindings = new MemoryBindingStore(),
) {
  return {
    config: runtimeConfig,
    service: {} as ConversationUseCases,
    bindings,
    logger: pino({ level: "silent" }),
    gatewayVersion: "0.146.0",
    codexUpstreamUserAgent: () => undefined,
    onFatal: vi.fn(),
    exchangeRate: () => null,
    priceCurrency: () => "usd" as const,
  };
}
