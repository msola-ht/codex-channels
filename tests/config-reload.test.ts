import { describe, expect, it } from "vitest";

import { classifyConfigReload, effectiveCodexBinary, removeUnauthorizedTelegramBindings } from "../src/bootstrap/index.js";
import type { GatewayConfig } from "../src/config/index.js";
import { TelegramAccessPolicy, WorkspaceRegistry } from "../src/policy/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";

const mainWorkspace = { id: "main", name: "Main", cwd: "/workspace" };

describe("Gateway config reload", () => {
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
      changes: ["Workspace", "Telegram 允许用户"],
    });
  });

  it.each([
    ["Telegram Bot Token", { telegramBotToken: "new-token" }],
    ["Telegram 代理", { telegramProxyUrl: "http://127.0.0.1:7890/" }],
    ["默认模型", { codexModel: "other-model" }],
  ] as const)("restarts for %s changes", (reason, change) => {
    expect(classifyConfigReload(config(), config(change))).toEqual({
      action: "restart",
      changes: [reason],
    });
  });

  it.each([
    ["Codex Binary", { codexBinary: "/opt/codex" }],
    ["Codex Socket", { codexSocketPath: "/tmp/other.sock" }],
  ] as const)("requires service reinstall for %s changes", (reason, change) => {
    expect(classifyConfigReload(config(), config(change))).toEqual({
      action: "reinstall",
      changes: [reason],
    });
  });

  it("restarts instead of hot reloading when a Telegram user is removed", () => {
    const current = config({ telegramAllowedUserIds: new Set([123, 456]) });
    const next = config({ telegramAllowedUserIds: new Set([123]) });

    expect(classifyConfigReload(current, next)).toEqual({
      action: "restart",
      changes: ["Telegram 用户撤权"],
    });
  });

  it("restarts when an existing workspace is removed or changed", () => {
    const current = config({
      workspaces: [mainWorkspace, { id: "docs", name: "Docs", cwd: "/docs" }],
    });

    expect(classifyConfigReload(current, config()).action).toBe("restart");
    expect(classifyConfigReload(current, config({
      workspaces: [{ ...mainWorkspace, cwd: "/moved" }, { id: "docs", name: "Docs", cwd: "/docs" }],
    }))).toEqual({ action: "restart", changes: ["已有 Workspace"] });
  });

  it("does nothing when the configuration is unchanged", () => {
    expect(classifyConfigReload(config(), config())).toEqual({ action: "reload", changes: [] });
  });

  it("atomically replaces the live Workspace registry and access policy", () => {
    const registry = new WorkspaceRegistry([mainWorkspace], "main");
    const access = new TelegramAccessPolicy(new Set([123]));

    registry.replace([mainWorkspace, { id: "docs", name: "Docs", cwd: "/docs" }], "main");
    access.replace(new Set([456]));

    expect(registry.resolve("docs").cwd).toBe("/docs");
    expect(access.isAllowed(123)).toBe(false);
    expect(access.isAllowed(456)).toBe(true);
  });

  it("removes persisted bindings for Telegram users that are no longer authorized", () => {
    const bindings = new MemoryBindingStore();
    bindings.bind({
      target: { surface: "telegram", conversationId: "123" },
      workspaceId: "main",
      threadId: "allowed-thread",
      sessionId: "allowed-session",
    });
    bindings.bind({
      target: { surface: "telegram", conversationId: "456" },
      workspaceId: "main",
      threadId: "revoked-thread",
      sessionId: "revoked-session",
    });

    expect(removeUnauthorizedTelegramBindings(bindings, new Set([123]))).toBe(1);
    expect(bindings.getByThread("allowed-thread")).toBeDefined();
    expect(bindings.getByThread("revoked-thread")).toBeUndefined();
  });
});

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "token",
    telegramAllowedUserIds: new Set([123]),
    codexBinary: "codex",
    workspaces: [mainWorkspace],
    defaultWorkspaceId: "main",
    codexSocketPath: "/tmp/codex.sock",
    codexSandbox: "workspace-write",
    stateDatabasePath: "/tmp/gateway.sqlite3",
    approvalTimeoutMs: 300_000,
    logLevel: "info",
    ...overrides,
  };
}
