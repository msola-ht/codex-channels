import { describe, expect, it, vi } from "vitest";

import {
  GatewayApplication,
  effectiveCodexBinary,
} from "../src/bootstrap/index.js";
import { removeUnauthorizedTelegramBindings } from "../src/bootstrap/surface-composition.js";
import {
  classifyConfigReload,
  type GatewayConfig,
} from "../src/config/index.js";
import { TelegramAccessPolicy, WorkspaceRegistry } from "../src/policy/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";

const mainWorkspace = { id: "main", name: "Main", cwd: "/workspace" };

describe("Gateway config reload", () => {
  it("applies hot reloads through every composed Surface module", () => {
    const current = config();
    const next = config({
      workspaces: [mainWorkspace, { id: "docs", name: "Docs", cwd: "/docs" }],
      telegramAllowedUserIds: new Set([123, 456]),
    });
    const applyHotReload = vi.fn();
    const replaceWorkspaces = vi.fn();
    const configurationChanged = vi.fn();
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      config: current,
      surfaceModules: [{ applyHotReload }],
      workspaces: { replace: replaceWorkspaces },
      surfaceManager: { configurationChanged },
    });

    const result = (application as unknown as GatewayApplication).reloadConfig(next);

    expect(result.action).toBe("reload");
    expect(applyHotReload).toHaveBeenCalledWith(next, result.changes);
    expect(replaceWorkspaces).toHaveBeenCalledWith(next.workspaces, next.defaultWorkspaceId);
    expect(configurationChanged).toHaveBeenCalledOnce();
  });

  it("restores Surface notification recipients after queuing a restart notice", () => {
    const restore = vi.fn();
    const prepareRestartNotification = vi.fn(() => restore);
    const configurationChanged = vi.fn();
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      config: config(),
      surfaceModules: [{ prepareRestartNotification }],
      surfaceManager: { configurationChanged },
    });
    const next = config({ telegramBotToken: "next-token" });

    const result = (application as unknown as GatewayApplication).reloadConfig(next);

    expect(result.action).toBe("restart");
    expect(prepareRestartNotification).toHaveBeenCalledWith(next);
    expect(configurationChanged).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it("restores prepared Surface recipients when a later restart hook fails", () => {
    const restore = vi.fn();
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      config: config(),
      surfaceModules: [
        { prepareRestartNotification: () => restore },
        { prepareRestartNotification: () => { throw new Error("prepare failed"); } },
      ],
      surfaceManager: { configurationChanged: vi.fn() },
    });

    expect(() => (application as unknown as GatewayApplication).reloadConfig(
      config({ telegramBotToken: "next-token" }),
    )).toThrow("prepare failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("uses the service-installed Codex path for the default command", () => {
    expect(effectiveCodexBinary("codex", { CODEX_BINARY: "/opt/codex/bin/codex" }))
      .toBe("/opt/codex/bin/codex");
    expect(effectiveCodexBinary("/custom/codex", { CODEX_BINARY: "/opt/codex/bin/codex" }))
      .toBe("/custom/codex");
  });

  it("hot reloads added workspaces and Telegram allowed users", () => {
    const current = config();
    const next = config({
      workspaces: [mainWorkspace, { id: "docs", name: "Docs", cwd: "/docs" }],
      telegramAllowedUserIds: new Set([123, 456]),
    });

    expect(classifyConfigReload(current, next)).toEqual({
      action: "reload",
      changes: [
        { code: "workspace.registry", scope: "global" },
        { code: "surface.telegram.allowed-users", scope: "telegram" },
      ],
    });
  });

  it.each([
    ["surface.telegram.token", "telegram", { telegramBotToken: "new-token" }],
    ["surface.telegram.proxy", "telegram", { telegramProxyUrl: "http://127.0.0.1:7890/" }],
    ["surface.telegram.message-format", "telegram", { telegramMessageFormat: "rich" }],
    ["display.operation-updates", "global", { operationUpdateDisplay: "compact" }],
    ["display.plan-updates", "global", { planUpdatesEnabled: true }],
    ["display.reasoning", "global", { reasoningEnabled: false }],
    ["display.price-currency", "global", { priceCurrency: "usd" }],
    ["experimental.plugin-api", "global", { pluginApiEnabled: false }],
    ["scheduled-tasks.enabled", "global", { scheduledTasksEnabled: true }],
    ["thread-sections.administrators", "global", {
      threadSectionAdministrators: new Set(["telegram:123"]),
    }],
    ["codex.default-model", "global", { codexModel: "other-model" }],
    ["metrics.sync", "global", {
      metricsSync: {
        enabled: true,
        endpoint: "https://worker.example.com/ingest",
        deviceToken: "token",
        batchSize: 200,
        intervalSeconds: 60,
      },
    }],
  ] as const)("restarts for %s changes", (code, scope, change) => {
    expect(classifyConfigReload(config(), config(change))).toEqual({
      action: "restart",
      changes: [{ code, scope }],
    });
  });

  it("restarts when Telegram is enabled or disabled", () => {
    const disabled = config({
      telegramEnabled: false,
      telegramBotToken: "",
      telegramAllowedUserIds: new Set(),
    });

    expect(classifyConfigReload(disabled, config())).toEqual({
      action: "restart",
      changes: [{ code: "surface.telegram.enabled", scope: "telegram" }],
    });
    expect(classifyConfigReload(config(), disabled)).toEqual({
      action: "restart",
      changes: [{ code: "surface.telegram.enabled", scope: "telegram" }],
    });
  });

  it("restarts when Feishu is enabled", () => {
    expect(classifyConfigReload(
      config(),
      config({
        feishu: {
          appId: "cli_0123456789abcdef",
          appSecret: "secret",
          allowedOpenIds: new Set(["ou_actor"]),
        },
      }),
    )).toEqual({
      action: "restart",
      changes: [{ code: "surface.feishu.enabled", scope: "feishu" }],
    });
  });

  it("restarts when Feishu credentials change", () => {
    const feishu = {
      appId: "cli_0123456789abcdef",
      appSecret: "secret",
      allowedOpenIds: new Set(["ou_actor"]),
    };
    const current = config({ feishu });

    expect(classifyConfigReload(
      current,
      config({
        feishu: {
          ...feishu,
          appSecret: "next-secret",
        },
      }),
    )).toEqual({
      action: "restart",
      changes: [{ code: "surface.feishu.credentials", scope: "feishu" }],
    });
  });

  it("hot reloads Feishu allowed Open IDs", () => {
    const current = config({
      feishu: {
        appId: "cli_0123456789abcdef",
        appSecret: "secret",
        allowedOpenIds: new Set(["ou_actor", "ou_reviewer"]),
      },
    });

    expect(classifyConfigReload(
      current,
      config({
        feishu: {
          appId: "cli_0123456789abcdef",
          appSecret: "secret",
          allowedOpenIds: new Set(["ou_actor"]),
        },
      }),
    )).toEqual({
      action: "reload",
      changes: [{ code: "surface.feishu.allowed-users", scope: "feishu" }],
    });
  });

  it("restarts when Weixin is enabled or its account changes", () => {
    const weixin = {
      accountId: "bot-fixture@im.bot",
      allowedUserIds: new Set(["actor-fixture@im.wechat"]),
    };
    expect(classifyConfigReload(config(), config({ weixin }))).toEqual({
      action: "restart",
      changes: [{ code: "surface.weixin.enabled", scope: "weixin" }],
    });
    expect(classifyConfigReload(
      config({ weixin }),
      config({
        weixin: {
          ...weixin,
          accountId: "other-fixture@im.bot",
        },
      }),
    )).toEqual({
      action: "restart",
      changes: [{ code: "surface.weixin.account", scope: "weixin" }],
    });
  });

  it("hot reloads added Weixin allowed user IDs", () => {
    const current = config({
      weixin: {
        accountId: "bot-fixture@im.bot",
        allowedUserIds: new Set(["actor-fixture@im.wechat"]),
      },
    });

    expect(classifyConfigReload(
      current,
      config({
        weixin: {
          accountId: "bot-fixture@im.bot",
          allowedUserIds: new Set([
            "actor-fixture@im.wechat",
            "reviewer-fixture@im.wechat",
          ]),
        },
      }),
    )).toEqual({
      action: "reload",
      changes: [{ code: "surface.weixin.allowed-users", scope: "weixin" }],
    });
  });

  it("restarts when Weixin allowed user IDs are removed", () => {
    const current = config({
      weixin: {
        accountId: "bot-fixture@im.bot",
        allowedUserIds: new Set([
          "actor-fixture@im.wechat",
          "reviewer-fixture@im.wechat",
        ]),
      },
    });

    expect(classifyConfigReload(
      current,
      config({
        weixin: {
          accountId: "bot-fixture@im.bot",
          allowedUserIds: new Set(["actor-fixture@im.wechat"]),
        },
      }),
    )).toEqual({
      action: "restart",
      changes: [{ code: "surface.weixin.allowed-users", scope: "weixin" }],
    });
  });

  it.each([
    ["codex.binary", { codexBinary: "/opt/codex" }],
    ["codex.socket", { codexSocketPath: "/tmp/other.sock" }],
    ["network.proxy", { networkProxy: { http: "http://127.0.0.1:7890" } }],
  ] as const)("requires service reinstall for %s changes", (code, change) => {
    expect(classifyConfigReload(config(), config(change))).toEqual({
      action: "reinstall",
      changes: [{ code, scope: "global" }],
    });
  });

  it("uses the highest required action while reporting every concurrent change", () => {
    const next = config({
      codexSocketPath: "/tmp/other.sock",
      telegramBotToken: "new-token",
      workspaces: [
        mainWorkspace,
        { id: "docs", name: "Docs", cwd: "/docs" },
      ],
      telegramAllowedUserIds: new Set([123, 456]),
    });

    expect(classifyConfigReload(config(), next)).toEqual({
      action: "reinstall",
      changes: [
        { code: "codex.socket", scope: "global" },
        { code: "surface.telegram.token", scope: "telegram" },
        { code: "workspace.registry", scope: "global" },
        { code: "surface.telegram.allowed-users", scope: "telegram" },
      ],
    });
  });

  it("restarts instead of hot reloading when a Telegram user is removed", () => {
    const current = config({ telegramAllowedUserIds: new Set([123, 456]) });
    const next = config({ telegramAllowedUserIds: new Set([123]) });

    expect(classifyConfigReload(current, next)).toEqual({
      action: "restart",
      changes: [{ code: "surface.telegram.allowed-users", scope: "telegram" }],
    });
  });

  it("restarts when an existing workspace is removed or changed", () => {
    const current = config({
      workspaces: [mainWorkspace, { id: "docs", name: "Docs", cwd: "/docs" }],
    });

    expect(classifyConfigReload(current, config()).action).toBe("restart");
    expect(classifyConfigReload(current, config({
      workspaces: [{ ...mainWorkspace, cwd: "/moved" }, { id: "docs", name: "Docs", cwd: "/docs" }],
    }))).toEqual({
      action: "restart",
      changes: [{ code: "workspace.registry", scope: "global" }],
    });
  });

  it("hot reloads when only workspace permissions change", () => {
    const current = config();

    expect(classifyConfigReload(current, config({
      workspaces: [{
        ...mainWorkspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      }],
    }))).toEqual({
      action: "reload",
      changes: [{ code: "workspace.registry", scope: "global" }],
    });
  });

  it("does nothing when the configuration is unchanged", () => {
    expect(classifyConfigReload(config(), config())).toEqual({ action: "reload", changes: [] });
  });

  it("atomically replaces the live Workspace registry and access policy", () => {
    const registry = new WorkspaceRegistry([mainWorkspace], "main");
    const access = new TelegramAccessPolicy(new Set([123]), "default");

    registry.replace([mainWorkspace, { id: "docs", name: "Docs", cwd: "/docs" }], "main");
    access.replace(new Set([456]));

    expect(registry.resolve("docs").cwd).toBe("/docs");
    const target = {
      surface: "telegram",
      accountId: "default",
      conversationId: "100",
    };
    expect(access.isAllowed({ target, actorId: "123" })).toBe(false);
    expect(access.isAllowed({ target, actorId: "456" })).toBe(true);
  });

  it("removes persisted bindings for Telegram users that are no longer authorized", () => {
    const bindings = new MemoryBindingStore();
    const allowedTarget = { surface: "telegram", accountId: "default", conversationId: "123" } as const;
    const revokedTarget = { surface: "telegram", accountId: "default", conversationId: "456" } as const;
    const groupTarget = { surface: "telegram", accountId: "default", conversationId: "-100" } as const;
    bindings.bind({
      target: allowedTarget,
      workspaceId: "main",
      threadId: "allowed-thread",
      sessionId: "allowed-session",
    });
    bindings.bind({
      target: revokedTarget,
      workspaceId: "main",
      threadId: "revoked-thread",
      sessionId: "revoked-session",
    });
    bindings.bind({
      target: groupTarget,
      workspaceId: "main",
      threadId: "group-thread",
      sessionId: "group-session",
    });
    bindings.bind({
      target: { surface: "feishu", accountId: "tenant-a", conversationId: "456" },
      workspaceId: "main",
      threadId: "feishu-thread",
      sessionId: "feishu-session",
    });
    bindings.bind({
      target: { surface: "telegram", accountId: "other", conversationId: "456" },
      workspaceId: "main",
      threadId: "other-bot-thread",
      sessionId: "other-bot-session",
    });
    bindings.rememberActor(allowedTarget, "123");
    bindings.rememberActor(revokedTarget, "456");
    bindings.rememberActor(groupTarget, "123");
    bindings.rememberActor(groupTarget, "456");

    expect(removeUnauthorizedTelegramBindings(bindings, new Set([123]))).toBe(1);
    expect(bindings.getByThread("allowed-thread")).toBeDefined();
    expect(bindings.getByThread("revoked-thread")).toBeUndefined();
    expect(bindings.getByThread("group-thread")).toBeDefined();
    expect(bindings.actors(groupTarget)).toEqual(["123"]);
    expect(bindings.getByThread("feishu-thread")).toBeDefined();
    expect(bindings.getByThread("other-bot-thread")).toBeDefined();
  });

  it("removes Telegram bindings whose authorized Actor is unknown", () => {
    const bindings = new MemoryBindingStore();
    const unknownActorTarget = {
      surface: "telegram",
      accountId: "default",
      conversationId: "-200",
    } as const;
    bindings.bind({
      target: unknownActorTarget,
      workspaceId: "main",
      threadId: "unknown-actor-thread",
      sessionId: "unknown-actor-session",
    });

    expect(removeUnauthorizedTelegramBindings(bindings, new Set([123]))).toBe(1);
    expect(bindings.getByThread("unknown-actor-thread")).toBeUndefined();
  });

});

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramEnabled: true,
    telegramBotToken: "token",
    telegramAllowedUserIds: new Set([123]),
    telegramMessageFormat: "html",
    codexBinary: "codex",
    networkProxy: {},
    workspaces: [mainWorkspace],
    defaultWorkspaceId: "main",
    codexSocketPath: "/tmp/codex.sock",
    codexSandbox: "workspace-write",
    operationUpdateDisplay: "full",
    planUpdatesEnabled: false,
    reasoningEnabled: true,
    pluginApiEnabled: true,
    scheduledTasksEnabled: false,
    threadSectionAdministrators: new Set(),
    priceCurrency: "cny",
    apiProviders: [],
    credentialsDirectory: "/tmp/credentials",
    stateDatabasePath: "/tmp/gateway.sqlite3",
    metricsStorage: { retentionDays: 365, maxRows: 1_000_000 },
    approvalTimeoutMs: 300_000,
    logLevel: "info",
    ...overrides,
  };
}
