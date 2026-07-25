import { describe, expect, it } from "vitest";

import {
  TelegramAccessPolicy,
  WorkspaceRegistry,
} from "../src/policy/index.js";

describe("WorkspaceRegistry", () => {
  it("keeps immutable snapshots of authorized Workspaces", () => {
    const source = { id: "main", name: "Main", cwd: "/workspace" };
    const registry = new WorkspaceRegistry([source], "main");

    source.cwd = "/outside";
    expect(registry.require("main").cwd).toBe("/workspace");

    expect(() => {
      Object.assign(registry.require("main"), { cwd: "/outside" });
    }).toThrow(TypeError);
    expect(registry.require("main").cwd).toBe("/workspace");
  });

  it("keeps the previous registry when a hot replacement is invalid", () => {
    const registry = new WorkspaceRegistry(
      [{ id: "main", name: "Main", cwd: "/workspace" }],
      "main",
    );

    expect(() => registry.replace(
      [{ id: "other", name: "Other", cwd: "/other" }],
      "missing",
    )).toThrow("默认 Workspace 不存在：missing");
    expect(registry.default()).toEqual({
      id: "main",
      name: "Main",
      cwd: "/workspace",
    });
  });

  it("rejects ambiguous Workspace names without widening authorization", () => {
    const registry = new WorkspaceRegistry(
      [
        { id: "first", name: "Shared", cwd: "/first" },
        { id: "second", name: "Shared", cwd: "/second" },
      ],
      "first",
    );

    expect(() => registry.resolve("Shared")).toThrow("Workspace 选择不唯一");
    expect(registry.resolve("second").cwd).toBe("/second");
  });
});

describe("TelegramAccessPolicy", () => {
  it("requires the exact Surface account and canonical Actor ID", () => {
    const configured = new Set([123]);
    const policy = new TelegramAccessPolicy(configured, "bot-a");
    configured.add(456);
    const target = {
      surface: "telegram" as const,
      accountId: "bot-a",
      conversationId: "chat",
    };

    expect(policy.isAllowed({ target, actorId: "123" })).toBe(true);
    expect(policy.isAllowed({ target, actorId: "0123" })).toBe(false);
    expect(policy.isAllowed({ target, actorId: "456" })).toBe(false);
    expect(policy.isAllowed({
      target: { ...target, accountId: "bot-b" },
      actorId: "123",
    })).toBe(false);
    expect(policy.isAllowed({
      target: { ...target, surface: "feishu" },
      actorId: "123",
    })).toBe(false);
  });
});
