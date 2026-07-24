import { describe, expect, it, vi } from "vitest";

import type { InteractionPort } from "../src/approval/index.js";
import {
  createTelegramRuntimeModule,
  type TelegramRuntimeAdapter,
} from "../src/bootstrap/surface-composition.js";
import type { GatewayConfig } from "../src/config/index.js";

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
