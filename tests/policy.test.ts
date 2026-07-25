import { describe, expect, it } from "vitest";

import {
  FeishuAccessPolicy,
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

describe("FeishuAccessPolicy", () => {
  it("requires the exact Surface account and open_id", () => {
    const configured = new Set(["ou_allowed"]);
    const policy = new FeishuAccessPolicy(configured, "cli_app");
    configured.add("ou_late");
    const target = {
      surface: "feishu" as const,
      accountId: "cli_app",
      conversationId: "oc_chat",
    };

    expect(policy.isAllowed({ target, actorId: "ou_allowed" })).toBe(true);
    expect(policy.isAllowed({ target, actorId: "OU_ALLOWED" })).toBe(false);
    expect(policy.isAllowed({ target, actorId: " ou_allowed" })).toBe(false);
    expect(policy.isAllowed({ target, actorId: "ou_late" })).toBe(false);
    expect(policy.isAllowed({
      target: { ...target, accountId: "cli_other" },
      actorId: "ou_allowed",
    })).toBe(false);
    expect(policy.isAllowed({
      target: { ...target, surface: "telegram" },
      actorId: "ou_allowed",
    })).toBe(false);
  });

  it("atomically replaces the allowed open_id snapshot", () => {
    const policy = new FeishuAccessPolicy(new Set(["ou_first"]), "cli_app");
    const replacement = new Set(["ou_second"]);
    const target = {
      surface: "feishu" as const,
      accountId: "cli_app",
      conversationId: "oc_chat",
    };

    policy.replace(replacement);
    replacement.add("ou_late");

    expect(policy.isAllowed({ target, actorId: "ou_first" })).toBe(false);
    expect(policy.isAllowed({ target, actorId: "ou_second" })).toBe(true);
    expect(policy.isAllowed({ target, actorId: "ou_late" })).toBe(false);
  });
});
