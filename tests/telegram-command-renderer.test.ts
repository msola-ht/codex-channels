import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import {
  renderTelegramCommandResult,
  threadQueueDeleteConfirmationKeyboard,
  threadQueueItemKeyboard,
  threadSectionKeyboard,
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
        outcome: {
          type: "thread.resumed",
          threadId: "<unsafe>",
          model: { model: "gpt-test", modelProvider: "openai" },
        },
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
          model: { model: "gpt-test", modelProvider: "openai" },
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

  it("confirms a native Queue write and its persistence", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: {
          type: "thread-queue.added",
          item: {
            id: "queue-2",
            clientUserMessageId: "client-2",
            inputType: "text",
            textPreview: "继续检查",
            editable: true,
          },
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("已写入 App Server Queue"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Gateway 重启不会清空"));
  });

  it("renders Queue pagination, refresh, and complete-ID item buttons", async () => {
    const replies: Array<{ text: string; options?: unknown }> = [];
    const reply = vi.fn(async (text: string, options?: unknown) => {
      replies.push({ text, options });
    });
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: `01a02373-1bd5-7661-aa48-fc0ff087f0${String(index).padStart(2, "0")}`,
      clientUserMessageId: `client-${index}`,
      inputType: "text" as const,
      textPreview: `安全预览 ${index + 1}`,
      editable: true,
    }));
    const result = {
      kind: "thread-queue" as const,
      result: {
        items,
        selectors: items.map((_, index) => String(index + 1)),
        page: 1,
        pageCount: 2,
        totalItemCount: 25,
      },
    };

    await renderTelegramCommandResult({ reply } as unknown as Context, result);

    const options = replies[0]?.options as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = options.reply_markup.inline_keyboard.flatMap((row) =>
      row.map((button) => button.callback_data).filter((value): value is string => value !== undefined));
    expect(callbacks).toContain("queue:page:2");
    expect(callbacks).toContain("queue:refresh:1");
    expect(callbacks).toContain(`queue:item:1:${items[0]!.id}`);
    expect(callbacks.every((callback) => callback.length <= 64)).toBe(true);
    const operationCallbacks = [
      ...threadQueueItemKeyboard(1, items[0]!.id).inline_keyboard,
      ...threadQueueDeleteConfirmationKeyboard(1, items[0]!.id).inline_keyboard,
    ].flatMap((row) => row.flatMap((button) =>
      "callback_data" in button ? [button.callback_data] : []));
    expect(operationCallbacks.every((callback) => callback.length <= 64)).toBe(true);
    expect(replies[0]?.text).toContain("新增、更新、排序请继续使用 /queue 文本命令");
  });

  it("renders scheduled-task confirmation as native confirm and cancel buttons", async () => {
    const replies: Array<{ text: string; options?: unknown }> = [];
    const reply = vi.fn(async (text: string, options?: unknown) => {
      replies.push({ text, options });
    });
    const token = "12345678-1234-1234-1234-123456789abc";

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "scheduled-confirmation",
        preview: {
          action: "create",
          token,
          expiresAt: Date.now() + 60_000,
          task: {
            taskId: "task-preview",
            name: "每小时检查",
            status: "active",
            schedule: { type: "interval", intervalMinutes: 60, anchorAt: 1 },
            timezone: "Asia/Shanghai",
            nextRunAt: 2,
            workspaceId: "main",
            modelProvider: "openai",
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
            serviceTier: null,
            sandbox: "workspace-write",
            permissions: null,
            promptPreview: "检查项目",
          },
        },
      },
    );

    const options = replies[0]?.options as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(options.reply_markup.inline_keyboard.flat()).toEqual([
      { text: "确认", callback_data: `schedule:confirm:${token}` },
      { text: "取消", callback_data: "schedule:cancel" },
    ]);
  });

  it("renders a scheduled-task creation outcome as HTML instead of raw Markdown", async () => {
    const reply = vi.fn(async () => undefined);

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "outcome",
        outcome: {
          type: "scheduled-task.created",
          task: {
            taskId: "task-1",
            name: "提醒我收到",
            status: "active",
            schedule: { type: "once", date: "2026-08-24", time: "10:33" },
            timezone: "Asia/Shanghai",
            nextRunAt: Date.parse("2026-08-24T02:33:00.000Z"),
            workspaceId: "main",
            modelProvider: "opencode-go",
            model: "deepseek-v4-flash-vision-exp",
            reasoningEffort: "high",
            serviceTier: null,
            sandbox: "workspace-write",
            permissions: null,
            promptPreview: "提醒我收到",
          },
        },
      },
    );

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("<b>已创建 Gateway 计划任务</b>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(reply).not.toHaveBeenCalledWith(expect.stringContaining("##"));
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
      selectors: ["1"],
      loadErrorCount: 0,
      totalPluginCount: 1,
      matchedPluginCount: 1,
      page: 1,
      pageCount: 1,
      searchTerm: null,
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
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{
            text: "GitHub",
            callback_data: "plugin:select:KJV9Ut1pei2MHRjX-Hp6Eak7zSnaNGeVAK2Bhk0mAMA",
          }]],
        },
      }),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("&lt;unsafe&gt;"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("adds bounded Plugin page buttons without losing the shared text fallback", async () => {
    const reply = vi.fn<(text: string, options?: unknown) => Promise<void>>(
      async () => undefined,
    );

    await renderTelegramCommandResult(
      { reply } as unknown as Context,
      {
        kind: "plugins",
        plugins: [{
          id: "plugin-9@local",
          name: "plugin-9",
          displayName: "Plugin 9",
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
        selectors: ["9"],
        loadErrorCount: 0,
        totalPluginCount: 10,
        matchedPluginCount: 10,
        page: 2,
        pageCount: 2,
        searchTerm: null,
      },
    );

    const options = reply.mock.calls[0]?.[1] as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(options.reply_markup.inline_keyboard.flat().map((button) =>
      button.callback_data)).toEqual([
      "plugin:select:4DWUNaFqScX_pDiNDM0Lh8MTPWDlhhzK0WsHucL3Ssg",
      "plugin:page:1",
    ]);
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

  it("builds bounded Thread Section move and paging buttons", () => {
    const keyboard = threadSectionKeyboard({
      kind: "thread-sections",
      sections: [
        {
          id: "section-pinned",
          name: "Pinned",
          builtIn: "pinned",
          currentWorkspaceActiveCount: 1,
          currentWorkspaceArchivedCount: 0,
        },
        {
          id: "section-project",
          name: "项目",
          builtIn: null,
          currentWorkspaceActiveCount: 1,
          currentWorkspaceArchivedCount: 0,
        },
      ],
      selectors: ["1", "2"],
      page: 2,
      pageCount: 3,
      totalSectionCount: 17,
      canManageCustomSections: false,
    });
    const callbacks = keyboard?.inline_keyboard.flatMap((row) =>
      row.map((button) => (button as { callback_data: string }).callback_data));
    expect(callbacks).toContain("section:pin");
    expect(callbacks?.some((callback) => callback.startsWith("section:move:")))
      .toBe(false);
    expect(callbacks).toContain("section:page:1");
    expect(callbacks).toContain("section:page:3");

    const administratorKeyboard = threadSectionKeyboard({
      kind: "thread-sections",
      sections: [{
        id: "section-project",
        name: "项目",
        builtIn: null,
        currentWorkspaceActiveCount: 1,
        currentWorkspaceArchivedCount: 0,
      }],
      selectors: ["2"],
      page: 1,
      pageCount: 1,
      totalSectionCount: 2,
      canManageCustomSections: true,
    });
    const administratorCallbacks = administratorKeyboard?.inline_keyboard.flatMap((row) =>
      row.map((button) => (button as { callback_data: string }).callback_data));
    expect(administratorCallbacks?.[0]).toMatch(/^section:move:[A-Za-z0-9_-]{43}$/u);

    expect(threadSectionKeyboard({
      kind: "thread-sections",
      sections: [],
      selectors: [],
      page: 4,
      pageCount: 3,
      totalSectionCount: 17,
      canManageCustomSections: false,
    })).toBeUndefined();
  });
});
