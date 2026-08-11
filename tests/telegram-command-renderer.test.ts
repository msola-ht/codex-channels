import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import {
  renderTelegramCommandResult,
  workspacePermissionFieldKeyboard,
  workspacePermissionKeyboard,
} from "../src/surfaces/telegram/command-renderer.js";
import { formatRuntimeMcpStatusUpdate } from "../src/surfaces/runtime-status-format.js";

describe("Telegram command renderer", () => {
  it("does not duplicate the Turn lifecycle acknowledgement for a new Plugin task", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: {
          type: "plugin.started",
          pluginName: "GitHub",
          turnId: "turn-1",
          steered: false,
        },
      },
    );

    expect(reply).not.toHaveBeenCalled();
  });

  it("renders Bearer Token MCP authentication as information", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "mcp-login",
        login: {
          type: "bearerToken",
          server: "token-tools",
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("已使用 Bearer Token 认证，无需 OAuth 登录"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(reply).not.toHaveBeenCalledWith(
      expect.stringContaining("操作失败"),
      expect.anything(),
    );
  });

  it("renders expanded shared notices through the safe HTML panel path", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: { type: "thread.resumed", threadId: "<unsafe>" },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("&lt;unsafe&gt;"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("identifies the previous channel after an automatic Thread takeover", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: {
          type: "thread.resumed",
          threadId: "thread-1",
          transferredFrom: "feishu",
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("已从飞书接管 Codex Thread"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("keeps brief notices as native platform text", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: { type: "turn.stop-requested", stopped: true },
      },
    );

    expect(reply).toHaveBeenCalledWith("## 已请求停止当前任务。");
  });

  it("confirms queued follow-ups and explains their in-memory lifetime", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: { type: "turn.follow-up-queued", position: 2 },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      "## 已排到下一 Turn，当前第 2 条。队列仅保存在内存，Gateway 重启会清空。",
    );
  });

  it("uses the dedicated diff renderer for artifact results", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "artifacts",
        view: "diff",
        artifacts: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: "diff --git a/a.ts b/a.ts\n+const value = 1;",
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("diff"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("confirms project rule generation for the selected Workspace", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "project-rules",
        action: "initialized",
        projectRoot: "/workspace/project",
        rulesPath: "/workspace/project/.codex/rules/default.rules",
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("项目规则已生成并检查通过"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("/workspace/project/.codex/rules/default.rules"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("uses the shared localized Goal summary", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "goal",
        goal: {
          threadId: "thread-1",
          objective: "完成多渠道统一",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 100,
          timeUsedSeconds: 5,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("<b>状态：</b>进行中"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("<b>Tokens：</b>100 / 10 K"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("renders Plugin and MCP resource results through the shared safe panel", async () => {
    const reply = vi.fn(async () => undefined);
    const context = { reply } as unknown as Context;

    await renderTelegramCommandResult(context, {
      kind: "plugins",
      plugins: [{
        id: "github@local",
        name: "github",
        displayName: "GitHub",
        marketplaceName: "local",
        description: null,
        enabled: true,
        available: true,
        version: null,
        localVersion: null,
        source: "local",
        installedAt: null,
        developerName: null,
        category: null,
        capabilities: [],
        authPolicy: "onUse",
        eligiblePlanTypes: [],
        disabledReason: null,
      }],
      loadErrorCount: 0,
    });
    await renderTelegramCommandResult(context, {
      kind: "mcp-resource",
      resource: {
        server: "docs",
        requestedUri: "docs://index",
        contents: [{
          kind: "text",
          uri: "docs://index",
          mimeType: "text/plain",
          text: "<unsafe>",
          truncated: false,
        }],
        omittedContentCount: 0,
      },
    });

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("github@local"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("&lt;unsafe&gt;"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("shows MCP startup errors sanitized at the Client boundary", () => {
    const text = formatRuntimeMcpStatusUpdate({
      threadId: "thread-1",
      name: "docs",
      status: "failed",
      error: "认证失败，TOKEN=[REDACTED]",
      failureReason: null,
    });

    expect(text).toContain("原因：认证失败，TOKEN=[已隐藏]");
  });

  it("builds clickable workspace permission keyboards", () => {
    const first = workspacePermissionKeyboard();
    expect(first.inline_keyboard[0]?.map((button) =>
      (button as { callback_data: string }).callback_data))
      .toEqual(["wp:sandbox", "wp:approval", "wp:profile"]);

    const sandbox = workspacePermissionFieldKeyboard("sandbox");
    expect(sandbox.inline_keyboard.flatMap((row) =>
      row.map((button) => (button as { callback_data: string }).callback_data)))
      .toEqual([
        "wp:sandbox:read-only",
        "wp:sandbox:workspace-write",
        "wp:sandbox:danger-full-access",
        "wp:sandbox:clear",
      ]);

    const approval = workspacePermissionFieldKeyboard("approval");
    expect(approval.inline_keyboard.flatMap((row) =>
      row.map((button) => (button as { callback_data: string }).callback_data)))
      .toContain("wp:approval:never");
  });
});
