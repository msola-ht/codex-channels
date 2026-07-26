import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ConversationService } from "../src/application/index.js";
import type { InteractionPort } from "../src/approval/index.js";
import {
  createFeishuRuntimeModule,
  createSurfaceModules,
  createTelegramRuntimeModule,
  selectFeishuProxyUrl,
  type FeishuRuntimeAdapter,
  type TelegramRuntimeAdapter,
} from "../src/bootstrap/surface-composition.js";
import type { GatewayConfig } from "../src/config/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";

const interactions = {} as InteractionPort;

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
  it("registers Feishu only when its runtime config is enabled", () => {
    const disabled = createSurfaceModules(options(config()));
    const enabled = createSurfaceModules(options(config({
      feishu: {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
        allowedOpenIds: new Set(["ou_actor"]),
      },
    })));

    expect(disabled.map((module) => module.adapter.surface)).toEqual([
      "telegram",
    ]);
    expect(enabled.map((module) => module.adapter.surface)).toEqual([
      "telegram",
      "feishu",
    ]);
  });

  it("selects the shared HTTPS proxy unless NO_PROXY covers the Feishu host", () => {
    const proxy = {
      http: "http://127.0.0.1:7890",
      https: "http://127.0.0.1:7891",
      no: "localhost,.internal.example",
    };

    expect(selectFeishuProxyUrl(proxy, "open.feishu.cn")).toBe(
      "http://127.0.0.1:7891",
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
    )).toThrow("飞书代理只支持 http:// 或 https://");
    expect(() => selectFeishuProxyUrl(
      { https: "not a proxy URL" },
      "open.feishu.cn",
    )).toThrow("飞书代理配置无效");
    expect(selectFeishuProxyUrl(
      {
        all: "socks5://127.0.0.1:7890",
        no: ".feishu.cn",
      },
      "open.feishu.cn",
    )).toBeUndefined();
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
    stateDatabasePath: "/tmp/gateway.sqlite3",
    approvalTimeoutMs: 300_000,
    logLevel: "info",
    ...overrides,
  };
}

function options(runtimeConfig: GatewayConfig) {
  return {
    config: runtimeConfig,
    service: {} as ConversationService,
    bindings: new MemoryBindingStore(),
    logger: pino({ level: "silent" }),
    gatewayVersion: "0.145.0",
    codexUpstreamUserAgent: () => undefined,
    onFatal: vi.fn(),
  };
}
