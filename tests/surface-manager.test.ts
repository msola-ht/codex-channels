import pino from "pino";
import { describe, expect, it } from "vitest";

import type { InteractionPort } from "../src/approval/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import type { SurfaceAdapter } from "../src/surfaces/index.js";

const interactions = {} as InteractionPort;

describe("SurfaceManager", () => {
  it("starts in registration order and stops in reverse order", async () => {
    const calls: string[] = [];
    const manager = new SurfaceManager([
      surface("telegram", "default", calls),
      surface("feishu", "tenant-a", calls),
    ], pino({ level: "silent" }));

    await manager.start();
    await manager.stop();

    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "stop:feishu",
      "stop:telegram",
    ]);
  });

  it("rolls back started Surfaces when a later start fails", async () => {
    const calls: string[] = [];
    const manager = new SurfaceManager([
      surface("telegram", "default", calls),
      surface("feishu", "tenant-a", calls, { failStart: true }),
    ], pino({ level: "silent" }));

    await expect(manager.start()).rejects.toThrow("start failed");

    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "stop:feishu",
      "stop:telegram",
    ]);
  });

  it("continues stopping remaining Surfaces after one stop fails", async () => {
    const calls: string[] = [];
    const manager = new SurfaceManager([
      surface("telegram", "default", calls),
      surface("feishu", "tenant-a", calls, { failStop: true }),
    ], pino({ level: "silent" }));
    await manager.start();

    await expect(manager.stop()).rejects.toThrow("部分 Surface 未能停止");

    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "stop:feishu",
      "stop:telegram",
    ]);
  });

  it("retains failed Surfaces so a later cleanup attempt can retry them", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const retrying = surface("telegram", "default", calls);
    retrying.stop = async () => {
      attempts += 1;
      calls.push("stop:telegram");
      if (attempts === 1) {
        throw new Error("stop failed");
      }
    };
    const manager = new SurfaceManager([retrying], pino({ level: "silent" }));
    await manager.start();

    await expect(manager.stop()).rejects.toThrow("部分 Surface 未能停止");
    await expect(manager.stop()).resolves.toBeUndefined();

    expect(calls).toEqual([
      "start:telegram",
      "stop:telegram",
      "stop:telegram",
    ]);
  });

  it("forwards configuration changes only to started Surfaces", async () => {
    const calls: string[] = [];
    const adapter = surface("telegram", "default", calls);
    adapter.configurationChanged = (change) => {
      calls.push(`workspace:${change.addedWorkspaces[0]?.id}`);
    };
    const manager = new SurfaceManager([adapter], pino({ level: "silent" }));

    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "ignored", name: "Ignored", cwd: "/ignored" }],
    });
    await manager.start();
    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    });
    await manager.stop();

    expect(calls).toEqual([
      "start:telegram",
      "workspace:docs",
      "stop:telegram",
    ]);
  });

  it("filters Surface-scoped changes while preserving process restart notices", async () => {
    const calls: string[] = [];
    const telegram = surface("telegram", "default", calls);
    const feishu = surface("feishu", "tenant-a", calls);
    telegram.configurationChanged = (change) => {
      calls.push(`telegram:${change.action}:${change.changes.map((item) => item.code).join(",")}`);
    };
    feishu.configurationChanged = (change) => {
      calls.push(`feishu:${change.action}:${change.changes.map((item) => item.code).join(",")}`);
    };
    const manager = new SurfaceManager([telegram, feishu], pino({ level: "silent" }));
    await manager.start();
    calls.length = 0;

    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "surface.telegram.allowed-users", scope: "telegram" }],
      addedWorkspaces: [],
    });
    manager.configurationChanged({
      action: "restarting",
      changes: [{ code: "surface.telegram.token", scope: "telegram" }],
      addedWorkspaces: [],
    });

    expect(calls).toEqual([
      "telegram:reloaded:surface.telegram.allowed-users",
      "telegram:restarting:surface.telegram.token",
      "feishu:restarting:",
    ]);
    await manager.stop();
  });

  it("delivers global persistent changes to every Surface", async () => {
    const deliveries: string[] = [];
    const telegram = surface("telegram", "default", []);
    const feishu = surface("feishu", "tenant-a", []);
    telegram.deliverConfigurationChange = async (change) => {
      deliveries.push(`telegram:${change.changes[0]?.code}`);
    };
    feishu.deliverConfigurationChange = async (change) => {
      deliveries.push(`feishu:${change.changes[0]?.code}`);
    };
    const manager = new SurfaceManager([telegram, feishu], pino({ level: "silent" }));
    await manager.start();

    await manager.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    });

    expect(deliveries.sort()).toEqual([
      "feishu:workspace.registry",
      "telegram:workspace.registry",
    ]);
    await manager.stop();
  });

  it("reports when a Surface fails to deliver a persistent configuration notification", async () => {
    const calls: string[] = [];
    const accepted = surface("telegram", "default", calls);
    const rejected = surface("feishu", "tenant-a", calls);
    rejected.deliverConfigurationChange = async () => {
      throw new Error("delivery failed");
    };
    const manager = new SurfaceManager([accepted, rejected], pino({ level: "silent" }));
    await manager.start();

    await expect(manager.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    })).rejects.toThrow("部分 Surface 未收到配置事件");

    await manager.stop();
  });

  it("does not confirm persistent notifications before all Surfaces start", async () => {
    const manager = new SurfaceManager([
      surface("telegram", "default", []),
    ], pino({ level: "silent" }));

    await expect(manager.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    })).rejects.toThrow("Surface 尚未全部启动");
  });
});

function surface(
  id: string,
  accountId: string,
  calls: string[],
  failures: { failStart?: boolean; failStop?: boolean } = {},
): SurfaceAdapter {
  return {
    surface: id,
    accountId,
    interactions,
    async start() {
      calls.push(`start:${id}`);
      if (failures.failStart) {
        throw new Error("start failed");
      }
    },
    async stop() {
      calls.push(`stop:${id}`);
      if (failures.failStop) {
        throw new Error("stop failed");
      }
    },
    async deliverConfigurationChange() {},
  };
}
